import * as vscode from "vscode";
import { execFile, spawn } from "child_process";
import {
  AgentAdapter,
  AgentKind,
  AgentSelection,
  AutoDebateRounds,
  AutoDebateState,
  BridgePairCheck,
  BridgePairState,
  BridgePairStatus,
  BrokerConfig,
  BrokerSnapshot,
  ChatMessage,
  DEFAULT_DIRECTIONAL_ROLE_PREFIXES,
  DirectionalRolePrefixes,
  MessageAction,
  MonitoredSession,
  PairSlotStatus,
  ReturnMode,
  UsageSummary
} from "../types";
import { createId } from "../utils";
import { ClaudeAdapter } from "../adapters/ClaudeAdapter";
import { CodexAdapter } from "../adapters/codexAdapter";
import { ZCodeAdapter } from "../adapters/ZCodeAdapter";
import { isCdpReachable } from "../adapters/ZCodeCdpClient";
import {
  AutoForwardDecision,
  AutoForwardEngine,
  DEFAULT_AUTO_FORWARD_KEYWORDS,
  normalizeAutoForwardKeywords
} from "../automation/AutoForwardEngine";
import { BrokerLogger } from "../automation/BrokerLogger";
import { OfficialUiBridge } from "../automation/OfficialUiBridge";
import { OfficialTranscriptMonitor } from "../monitor/OfficialTranscriptMonitor";
import {
  buildBridgeAnswerPrompt,
  buildMonitoredBridgePrompt,
  MonitoredBridgeMode
} from "./bridgePrompt";

interface BridgeActionResult {
  ok: boolean;
  message?: string;
  error?: string;
  source?: AgentKind;
  target?: AgentKind;
  mode?: MonitoredBridgeMode;
  sessionId?: string;
  messageId?: string;
}

export class BrokerController implements vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<BrokerSnapshot>();
  private readonly messages: ChatMessage[] = [];
  // codex/claude 始终实例化；zcode 按 pair 选择 + 检测通过后实例化。
  private readonly adapters: Partial<Record<AgentKind, AgentAdapter>> = {};
  private readonly transcriptMonitor: OfficialTranscriptMonitor;
  private readonly autoForwardEngine = new AutoForwardEngine();
  private readonly uiBridge: OfficialUiBridge;
  private readonly pollTimer: NodeJS.Timeout;
  private monitorSnapshot = {
    enabled: true,
    lastUpdated: 0
  } as BrokerSnapshot["monitor"];
  private bridgeState: BrokerSnapshot["bridge"] = {
    busy: false
  };
  private autoForwardState: BrokerSnapshot["autoForward"] = {
    enabled: false,
    status: "idle"
  };
  private autoForwardSendActive = false;

  // 红蓝双方桥接对（内存态，重启回默认 claude↔codex）。
  private pair: BridgePairState = { red: "claude", blue: "codex" };
  private pairCheck: BridgePairCheck = {};
  private pairStatus: BridgePairStatus = {};

  private currentTarget: AgentKind = "codex";
  private busy = false;
  private autoDebateState: AutoDebateState = {
    active: false,
    startTarget: "codex",
    rounds: 1,
    returnMode: "compact",
    userMessageId: "",
    currentStep: 0,
    totalSteps: 0,
    currentPrompt: ""
  };
  private pendingResponseByMessageId = new Map<string, { target: AgentKind; requestText: string; plainTextOnly?: boolean }>();

  public constructor(
    private readonly cwd: string,
    private readonly logger?: BrokerLogger
  ) {
    this.adapters.codex = new CodexAdapter(() => this.getConfig(), cwd);
    this.adapters.claude = new ClaudeAdapter(() => this.getConfig(), cwd);
    this.transcriptMonitor = new OfficialTranscriptMonitor(this.cwd, (workspaceCwd) => this.readZCodeMonitoredSession(workspaceCwd));
    this.uiBridge = new OfficialUiBridge(this.cwd, this.logger);
    // 从持久化配置恢复上次的红蓝双方（重启不重置）。
    this.pair = this.loadPairFromConfig();
    this.pollTimer = setInterval(() => {
      void this.refreshMonitor();
    }, 1500);
    void this.refreshMonitor();
    // 启动时只更新检测状态（pairCheck），不清空用户选择的 pair。
    // ZCode 检测含自动启动（带调试端口），启动时不必强制跑。
    // 用户主动选 ZCode（setBridgePair）或转发时才触发检测。
    void this.refreshPairCheck();
  }

  // 只更新检测状态，不清空 pair（与 checkPair 的区别：失败不清槽位）。
  // 检测过程中实时更新 pairCheck[slot]（消息）和 pairStatus[slot]（红黄绿灯）并 emit。
  // allowRestart=false（构造/启动）：只读检测，CDP 不通报红，绝不杀 ZCode。
  // allowRestart=true（用户主动选 ZCode/点红灯）：允许 taskkill 重启。
  private async refreshPairCheck(allowRestart = false): Promise<void> {
    this.pairCheck = {};
    this.pairStatus = {};
    const slots: Array<"red" | "blue"> = ["red", "blue"];
    for (const slot of slots) {
      const agent = this.pair[slot];
      if (!agent) {
        this.pairCheck[slot] = "未选择";
        this.pairStatus[slot] = "none";
        this.emit();
        continue;
      }
      this.pairCheck[slot] = `检测中（${agent}）...`;
      this.pairStatus[slot] = "yellow";
      this.emit();
      const error = await this.checkAgentAvailable(agent, slot, allowRestart);
      // "__pending__" 表示 checkZcodeAvailable 已自设状态（如黄灯：exe 在但 CDP 没开），不覆盖。
      if (error === "__pending__") {
        // 状态已由 checkZcodeAvailable 通过 setSlotStatus 设好，跳过。
      } else if (error) {
        this.pairCheck[slot] = error;
        this.pairStatus[slot] = "red";
      } else {
        this.pairCheck[slot] = "就绪";
        this.pairStatus[slot] = "green";
      }
      this.emit();
    }
    this.emit();
  }

  // 单 slot 设置状态灯（供 checkZcodeAvailable 中间步骤细粒度更新）。
  private setSlotStatus(slot: "red" | "blue" | undefined, status: PairSlotStatus, message: string): void {
    if (!slot) {
      return;
    }
    this.pairStatus[slot] = status;
    this.pairCheck[slot] = message;
    this.emit();
  }

  private loadPairFromConfig(): BridgePairState {
    const raw = vscode.workspace.getConfiguration("broker").get<unknown>("bridgePair");
    if (raw && typeof raw === "object") {
      const entry = raw as Partial<Record<string, unknown>>;
      const validAgents: AgentKind[] = ["codex", "claude", "zcode"];
      const normalize = (v: unknown): AgentSelection => {
        if (typeof v === "string" && (validAgents as string[]).includes(v)) {
          return v as AgentKind;
        }
        return null;
      };
      const red = normalize(entry.red);
      const blue = normalize(entry.blue);
      // 只有保存过有效 pair 才用，否则保留默认 claude↔codex
      if (red || blue) {
        return { red, blue };
      }
    }
    return { red: "claude", blue: "codex" };
  }

  public get onDidChange(): vscode.Event<BrokerSnapshot> {
    return this.changeEmitter.event;
  }

  public getSnapshot(): BrokerSnapshot {
    const config = this.getConfig();
    return {
      workspaceCwd: this.cwd,
      currentTarget: this.currentTarget,
      busy: this.busy,
      pair: this.pair,
      pairCheck: this.pairCheck,
      pairStatus: this.pairStatus,
      autoDebate: {
        active: this.autoDebateState.active,
        rounds: this.autoDebateState.rounds,
        returnMode: this.autoDebateState.returnMode,
        startTarget: this.autoDebateState.startTarget,
        currentStep: this.autoDebateState.currentStep,
        totalSteps: this.autoDebateState.totalSteps
      },
      bridge: this.bridgeState,
      autoForward: {
        ...this.autoForwardState,
        enabled: config.autoForwardEnabled,
        keywords: config.autoForwardKeywords
      },
      directionalRolePrefixes: config.directionalRolePrefixes,
      zcodeDataDir: config.zcode.dataDir,
      monitor: this.filterMonitorByPair(this.monitorSnapshot)
    };
  }

  // 时间线只显示 pair 内两端：剔除不在红蓝双方的 agent session，避免误转发到第三端。
  private filterMonitorByPair(snapshot: BrokerSnapshot["monitor"]): BrokerSnapshot["monitor"] {
    const inPair = new Set<AgentKind>();
    if (this.pair.red) {
      inPair.add(this.pair.red);
    }
    if (this.pair.blue) {
      inPair.add(this.pair.blue);
    }
    const filtered: BrokerSnapshot["monitor"] = {
      enabled: snapshot.enabled,
      lastUpdated: snapshot.lastUpdated
    };
    if (inPair.has("codex")) {
      filtered.codex = snapshot.codex;
      filtered.codexError = snapshot.codexError;
    }
    if (inPair.has("claude")) {
      filtered.claude = snapshot.claude;
      filtered.claudeError = snapshot.claudeError;
    }
    if (inPair.has("zcode")) {
      filtered.zcode = snapshot.zcode;
      filtered.zcodeError = snapshot.zcodeError;
    }
    return filtered;
  }

  public async refreshMonitor(): Promise<void> {
    this.monitorSnapshot = await this.transcriptMonitor.readSnapshot(this.autoForwardEngine.getPendingSession());
    await this.evaluateAutoForward();
    this.emit();
  }

  public async bridgeMonitoredMessage(
    sourceAgent: AgentKind,
    sessionId: string,
    messageId: string,
    mode: MonitoredBridgeMode,
    extraText = ""
  ): Promise<BridgeActionResult> {
    const target = this.getBridgeTarget(sourceAgent);
    if (!target) {
      const error = "当前桥接对象未配置或不可用，请先在设置里选择红蓝双方。";
      this.bridgeState = {
        busy: false,
        source: sourceAgent,
        mode,
        error,
        updatedAt: Date.now()
      };
      this.emit();
      return { ok: false, error, source: sourceAgent, mode };
    }
    return this.bridgeMonitoredMessageToTarget(
      sourceAgent,
      target,
      sessionId,
      messageId,
      mode,
      extraText
    );
  }

  // 根据 pair 找出 sourceAgent 的对端：红方的对端是蓝方，反之。
  private getBridgeTarget(sourceAgent: AgentKind): AgentKind | null {
    if (this.pair.red === sourceAgent && this.pair.blue) {
      return this.pair.blue;
    }
    if (this.pair.blue === sourceAgent && this.pair.red) {
      return this.pair.red;
    }
    return null;
  }

  private getMonitoredSession(agent: AgentKind) {
    if (agent === "codex") {
      return this.monitorSnapshot.codex;
    }
    if (agent === "claude") {
      return this.monitorSnapshot.claude;
    }
    return this.monitorSnapshot.zcode;
  }

  private async bridgeMonitoredMessageToTarget(
    sourceAgent: AgentKind,
    target: AgentKind,
    sessionId: string,
    messageId: string,
    mode: MonitoredBridgeMode,
    extraText = "",
    trigger: "manual" | "auto-forward" = "manual"
  ): Promise<BridgeActionResult> {
    if (this.bridgeState.busy) {
      const error = "已有一条桥接发送正在进行，请稍后重试。";
      this.bridgeState = {
        ...this.bridgeState,
        error,
        updatedAt: Date.now(),
        busy: this.bridgeState.busy
      };
      this.emit();
      return { ok: false, error, source: sourceAgent, target, mode };
    }

    const session = this.getMonitoredSession(sourceAgent);
    if (!session || session.sessionId !== sessionId) {
      const error = "监控数据已经刷新，请重试这条消息。";
      this.bridgeState = {
        busy: false,
        source: sourceAgent,
        mode,
        error,
        updatedAt: Date.now()
      };
      this.emit();
      return { ok: false, error, source: sourceAgent, target, mode };
    }

    const messageIndex = session.messages.findIndex((entry) => entry.id === messageId);
    if (messageIndex === -1) {
      const error = "未找到要桥接的消息。";
      this.bridgeState = {
        busy: false,
        source: sourceAgent,
        mode,
        error,
        updatedAt: Date.now()
      };
      this.emit();
      return { ok: false, error, source: sourceAgent, target, mode, sessionId };
    }

    const promptResult =
      mode === "forward-answer"
        ? buildBridgeAnswerPrompt(
            sourceAgent,
            target,
            session.messages[messageIndex]?.text ?? "",
            extraText,
            this.getDirectionalRolePrefix(sourceAgent, target)
          )
        : buildMonitoredBridgePrompt(
            sourceAgent,
            target,
            session.messages,
            messageIndex,
            mode,
            extraText,
            this.getDirectionalRolePrefix(sourceAgent, target)
          );
    if (!promptResult.ok) {
      this.bridgeState = {
        busy: false,
        source: sourceAgent,
        mode,
        target,
        error: promptResult.error,
        updatedAt: Date.now()
      };
      this.emit();
      return {
        ok: false,
        error: promptResult.error,
        source: sourceAgent,
        target,
        mode,
        sessionId,
        messageId
      };
    }

    this.bridgeState = {
      busy: true,
      source: sourceAgent,
      target,
      mode,
      message: `正在桥接到 ${this.agentLabel(target)}...`,
      updatedAt: Date.now()
    };
    this.emit();
    this.logger?.info(
      `bridge action start trigger=${trigger} source=${sourceAgent} target=${target} mode=${mode} session=${sessionId} message=${messageId} chars=${promptResult.prompt.length}`
    );

    try {
      // 按目标 agent 类型分发：claude/codex 走官方面板 SendKeys，zcode 走 app-server。
      const result = await this.dispatchBridge(target, promptResult.prompt, trigger);
      this.bridgeState = {
        busy: false,
        source: sourceAgent,
        target,
        mode,
        message: result,
        updatedAt: Date.now()
      };
      this.emit();
      this.logger?.info(`bridge action success trigger=${trigger} source=${sourceAgent} target=${target} mode=${mode} message=${messageId}`);
      return { ok: true, message: result, source: sourceAgent, target, mode, sessionId, messageId };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.bridgeState = {
        busy: false,
        source: sourceAgent,
        target,
        mode,
        error: message,
        updatedAt: Date.now()
      };
      this.emit();
      this.logger?.error(`bridge action failed trigger=${trigger} source=${sourceAgent} target=${target} mode=${mode} message=${messageId}: ${message}`);
      return { ok: false, error: message, source: sourceAgent, target, mode, sessionId, messageId };
    }
  }

  // 转发通道分发：Codex/Claude 走官方面板（SendKeys，已验证可靠），ZCode 走 app-server。
  private async dispatchBridge(
    target: AgentKind,
    prompt: string,
    trigger: "manual" | "auto-forward"
  ): Promise<string> {
    if (target === "zcode") {
      const adapter = this.adapters.zcode;
      if (!adapter) {
        throw new Error("ZCode adapter 不可用，请先在设置里选择 ZCode 并确保检测通过。");
      }
      // sendMessage await 到 session/send 成功即 resolve；轮询回复不阻塞转发。
      // 转发场景不回显流式内容，提供最小回调即可。
      await adapter.sendMessage({ text: prompt }, {
        onTextDelta: () => {},
        onComplete: () => {},
        onError: () => {}
      });
      return "已桥接发送到 ZCode 会话（app-server）。";
    }
    return this.uiBridge.sendToAgent(target, prompt, { trigger });
  }

  public setCurrentTarget(target: AgentKind): void {
    this.currentTarget = target;
    this.emit();
  }

  public async setAutoForwardEnabled(enabled: boolean): Promise<void> {
    await vscode.workspace.getConfiguration("broker").update("autoForwardEnabled", enabled, vscode.ConfigurationTarget.Workspace);
    this.autoForwardEngine.resetBaseline(this.monitorSnapshot, enabled);
    this.autoForwardState = this.autoForwardEngine.getState();
    this.emit();
  }

  public async setAutoForwardKeywords(keywords: unknown): Promise<void> {
    const normalizedKeywords = normalizeAutoForwardKeywords(keywords);
    await vscode.workspace
      .getConfiguration("broker")
      .update("autoForwardKeywords", normalizedKeywords, vscode.ConfigurationTarget.Workspace);
    this.autoForwardEngine.resetBaseline(this.monitorSnapshot, this.getConfig().autoForwardEnabled);
    this.autoForwardState = this.autoForwardEngine.getState();
    this.emit();
  }

  public async setDirectionalRolePrefixes(prefixes: unknown): Promise<void> {
    const normalizedPrefixes = normalizeDirectionalRolePrefixes(prefixes);
    await vscode.workspace
      .getConfiguration("broker")
      .update("directionalRolePrefixes", normalizedPrefixes, vscode.ConfigurationTarget.Workspace);
    this.emit();
  }

  public async sendUserPrompt(text: string, target = this.currentTarget): Promise<void> {
    if (this.busy) {
      this.pushSystemMessage("Another model response is still running. Stop it before sending a new prompt.");
      return;
    }

    const userMessage = this.pushMessage({
      id: createId(),
      role: "user",
      text,
      createdAt: Date.now()
    });

    await this.runAgent(target, text, {
      replyToUserMessageId: userMessage.id,
      isFirstResponseToUserMessage: true,
      isAutoDebateStep: false,
      requestText: text
    });
  }

  public async startAutoDebate(text: string, rounds: AutoDebateRounds, returnMode: ReturnMode, startTarget: AgentKind): Promise<void> {
    if (this.busy) {
      this.pushSystemMessage("Stop the active response before starting auto debate.");
      return;
    }

    const userMessage = this.pushMessage({
      id: createId(),
      role: "user",
      text,
      createdAt: Date.now()
    });

    this.autoDebateState = {
      active: true,
      startTarget,
      rounds,
      returnMode,
      userMessageId: userMessage.id,
      currentStep: 0,
      totalSteps: rounds * 2 - 1,
      currentPrompt: text
    };
    this.emit();

    await this.runAutoDebateStep(startTarget, text, userMessage.id, 0);
  }

  public async handleAction(messageId: string, actionKind: MessageAction["kind"], payload?: Record<string, string | number | boolean>): Promise<void> {
    const message = this.messages.find((entry) => entry.id === messageId);
    if (!message) {
      return;
    }

    switch (actionKind) {
      case "merge-forward":
        await this.forwardMerged(message);
        break;
      case "forward-answer":
        await this.forwardAnswerOnly(message);
        break;
      case "continue-current":
      case "switch-target":
        if (payload?.target === "codex" || payload?.target === "claude" || payload?.target === "zcode") {
          this.currentTarget = payload.target;
          this.emit();
        }
        break;
      case "approval-approve":
      case "approval-deny":
        if (message.role === "approval" && message.approval) {
          const approvalAgent = message.approval.agent;
          await this.adapters[approvalAgent]?.resolveApproval?.(
            message.approval.requestId,
            actionKind === "approval-approve" ? "approve" : "deny"
          );
          message.approval.resolved = true;
          message.actions = [];
          this.emit();
        }
        break;
      case "approval-details":
        if (message.role === "approval" && message.approval) {
          this.pushSystemMessage(message.approval.detail);
        }
        break;
      case "retry-claude":
      case "retry-claude-plain": {
        const pending = this.pendingResponseByMessageId.get(messageId);
        if (!pending) {
          return;
        }
        await this.runAgent("claude", pending.requestText, {
          isAutoDebateStep: false,
          plainTextOnly: actionKind === "retry-claude-plain",
          requestText: pending.requestText
        });
        break;
      }
      default:
        break;
    }
  }

  public async stop(): Promise<void> {
    if (this.busy) {
      await Promise.all(this.allAdapters().map((adapter) => adapter.stop()));
      this.busy = false;
      this.autoDebateState.active = false;
      this.pushSystemMessage("Active response stopped.");
    }
    await this.refreshMonitor();
    this.emit();
  }

  public async newSession(): Promise<void> {
    await Promise.all(this.allAdapters().map((adapter) => adapter.dispose()));
    this.messages.splice(0, this.messages.length);
    this.pendingResponseByMessageId.clear();
    this.currentTarget = "codex";
    this.busy = false;
    this.bridgeState = {
      busy: false
    };
    this.autoDebateState = {
      active: false,
      startTarget: "codex",
      rounds: this.getConfig().defaultAutoDebateRounds,
      returnMode: this.getConfig().defaultReturnMode,
      userMessageId: "",
      currentStep: 0,
      totalSteps: 0,
      currentPrompt: ""
    };
    await this.refreshMonitor();
    this.emit();
  }

  public dispose(): void {
    clearInterval(this.pollTimer);
    this.changeEmitter.dispose();
    for (const adapter of this.allAdapters()) {
      void adapter.dispose();
    }
  }

  private allAdapters(): AgentAdapter[] {
    const list: AgentAdapter[] = [];
    for (const key of Object.keys(this.adapters) as AgentKind[]) {
      const adapter = this.adapters[key];
      if (adapter) {
        list.push(adapter);
      }
    }
    return list;
  }

  private async forwardMerged(message: ChatMessage): Promise<void> {
    const target = this.getBridgeTarget(message.role as AgentKind) ?? this.fallbackTarget(message.role as AgentKind);
    const relatedUser = this.findRelatedUserMessage(message);
    if (!relatedUser) {
      this.pushSystemMessage("No related user message was found for merge-forward.");
      return;
    }

    const sourceLabel = this.agentLabel(message.role as AgentKind);
    const prompt = `User question:\n${relatedUser.text}\n\n${sourceLabel} answer:\n${message.text}\n\nPlease continue from this context.`;
    if (target) {
      await this.runAgent(target, prompt, {
        replyToUserMessageId: relatedUser.id,
        isFirstResponseToUserMessage: false,
        isAutoDebateStep: false,
        requestText: prompt
      });
    }
  }

  private async forwardAnswerOnly(message: ChatMessage): Promise<void> {
    const target = this.getBridgeTarget(message.role as AgentKind) ?? this.fallbackTarget(message.role as AgentKind);
    if (!target) {
      this.pushSystemMessage("当前桥接对象未配置，请先在设置里选择红蓝双方。");
      return;
    }
    const sourceLabel = this.agentLabel(message.role as AgentKind);
    const prompt = `${sourceLabel}说：\n${message.text}`;
    await this.runAgent(target, prompt, {
      replyToUserMessageId: message.replyToUserMessageId,
      isFirstResponseToUserMessage: false,
      isAutoDebateStep: false,
      requestText: prompt,
      plainTextOnly: true
    });
  }

  private fallbackTarget(sourceAgent: AgentKind): AgentKind | null {
    const direct = this.getBridgeTarget(sourceAgent);
    if (direct) {
      return direct;
    }
    // sourceAgent 不在当前 pair 内时，回退到 pair 里任一可用 agent。
    return this.pair.red ?? this.pair.blue ?? null;
  }

  private agentLabel(agent: AgentKind): string {
    if (agent === "codex") {
      return "Codex";
    }
    if (agent === "claude") {
      return "ClaudeCode";
    }
    return "ZCode";
  }

  private async runAutoDebateStep(target: AgentKind, prompt: string, userMessageId: string, stepIndex: number): Promise<void> {
    this.autoDebateState.currentStep = stepIndex + 1;
    this.emit();

    const responseMessage = await this.runAgent(target, prompt, {
      replyToUserMessageId: userMessageId,
      isFirstResponseToUserMessage: stepIndex === 0,
      isAutoDebateStep: true,
      requestText: prompt
    });

    if (!responseMessage || !this.autoDebateState.active) {
      return;
    }

    if (stepIndex + 1 >= this.autoDebateState.totalSteps) {
      this.autoDebateState.active = false;
      this.emit();
      return;
    }

    const nextTarget: AgentKind = target === "codex" ? "claude" : "codex";
    const nextPrompt = this.buildAutoDebatePrompt(nextTarget, responseMessage);
    await this.runAutoDebateStep(nextTarget, nextPrompt, userMessageId, stepIndex + 1);
  }

  private buildAutoDebatePrompt(nextTarget: AgentKind, sourceMessage: ChatMessage): string {
    const userMessage = this.findRelatedUserMessage(sourceMessage);
    const userText = userMessage?.text ?? "";
    const sourceLabel = this.agentLabel(sourceMessage.role as AgentKind);
    const targetLabel = this.agentLabel(nextTarget);
    const isReturningToStarter = nextTarget === this.autoDebateState.startTarget;

    if (this.autoDebateState.currentStep === 1) {
      return `Original user question:\n${userText}\n\n${sourceLabel} draft:\n${sourceMessage.text}\n\n${targetLabel}, review this draft, point out weaknesses, and suggest a stronger answer.`;
    }

    if (isReturningToStarter && this.autoDebateState.returnMode === "compact") {
      return `Please revise your previous answer using this review feedback:\n\n${sourceMessage.text}`;
    }

    return `Original user question:\n${userText}\n\nLatest answer or review:\n${sourceMessage.text}\n\nPlease continue the debate and improve the answer.`;
  }

  private async runAgent(
    target: AgentKind,
    text: string,
    options: {
      replyToUserMessageId?: string;
      isFirstResponseToUserMessage?: boolean;
      isAutoDebateStep?: boolean;
      plainTextOnly?: boolean;
      requestText: string;
    }
  ): Promise<ChatMessage | undefined> {
    this.busy = true;
    this.currentTarget = target;

    const adapter = this.adapters[target];
    if (!adapter) {
      this.busy = false;
      this.pushSystemMessage(`${target} adapter 不可用，请先在设置里选择并检测桥接对象。`);
      return undefined;
    }

    const placeholder = this.pushMessage({
      id: createId(),
      role: target,
      text: "",
      thinking: "",
      createdAt: Date.now(),
      pending: true,
      replyToUserMessageId: options.replyToUserMessageId,
      isFirstResponseToUserMessage: options.isFirstResponseToUserMessage,
      isAutoDebateStep: options.isAutoDebateStep,
      sourceAgent: target
    });
    this.pendingResponseByMessageId.set(placeholder.id, {
      target,
      requestText: options.requestText,
      plainTextOnly: options.plainTextOnly
    });
    this.emit();

    let usage: UsageSummary | undefined;
    let failed = false;
    let failureDetail = "";

    await adapter.sendMessage(
      {
        text,
        plainTextOnly: options.plainTextOnly
      },
      {
        onTextDelta: (delta) => {
          placeholder.text += delta;
          this.emit();
        },
        onThinkingDelta: (delta) => {
          placeholder.thinking = (placeholder.thinking ?? "") + delta;
          this.emit();
        },
        onApproval: (approval) => {
          this.pushMessage({
            id: createId(),
            role: "approval",
            text: approval.title,
            createdAt: Date.now(),
            approval,
            actions: this.buildApprovalActions()
          });
          this.emit();
        },
        onSystemMessage: (systemText) => {
          this.pushSystemMessage(systemText);
        },
        onComplete: (summary) => {
          usage = summary;
        },
        onError: (error, detail) => {
          failed = true;
          failureDetail = detail || error.message;
        }
      }
    );

    placeholder.pending = false;
    placeholder.usage = usage;
    this.busy = false;

    if (failed) {
      placeholder.error = true;
      placeholder.text = placeholder.text || failureDetail || "The response failed before any text was returned.";
      placeholder.actions = target === "claude" ? this.buildClaudeRetryActions() : this.buildMessageActions(placeholder);
      this.pushSystemMessage(
        target === "claude"
          ? `Claude run failed: ${failureDetail}`
          : `Codex run failed: ${failureDetail}`
      );
      this.autoDebateState.active = false;
    } else {
      placeholder.actions = this.buildMessageActions(placeholder);
    }

    this.emit();
    return failed ? undefined : placeholder;
  }

  private buildMessageActions(message: ChatMessage): MessageAction[] {
    if (message.role !== "codex" && message.role !== "claude") {
      return [];
    }

    const actions: MessageAction[] = [];
    if (message.isFirstResponseToUserMessage && !message.isAutoDebateStep) {
      actions.push({ kind: "merge-forward", label: "合并发送给另一模型" });
    }
    actions.push({ kind: "forward-answer", label: "仅发送这条回答" });
    actions.push({
      kind: "continue-current",
      label: "继续问当前模型",
      payload: { target: message.role }
    });
    actions.push({
      kind: "switch-target",
      label: "切换到另一模型继续问",
      payload: { target: (this.getBridgeTarget(message.role as AgentKind) ?? this.fallbackTarget(message.role as AgentKind) ?? message.role) as string }
    });
    return actions;
  }

  private buildApprovalActions(): MessageAction[] {
    return [
      { kind: "approval-approve", label: "Approve" },
      { kind: "approval-deny", label: "Deny" },
      { kind: "approval-details", label: "Details" }
    ];
  }

  private buildClaudeRetryActions(): MessageAction[] {
    return [
      { kind: "retry-claude", label: "重试本条" },
      { kind: "retry-claude-plain", label: "改发纯文本" }
    ];
  }

  private findRelatedUserMessage(message: ChatMessage): ChatMessage | undefined {
    if (!message.replyToUserMessageId) {
      return undefined;
    }
    return this.messages.find((entry) => entry.id === message.replyToUserMessageId);
  }

  private async evaluateAutoForward(): Promise<void> {
    if (this.autoForwardSendActive) {
      return;
    }

    const config = this.getConfig();
    const decision = this.autoForwardEngine.evaluate(this.monitorSnapshot, {
      enabled: config.autoForwardEnabled,
      keywords: config.autoForwardKeywords
    });
    this.autoForwardState = this.autoForwardEngine.getState();

    if (!decision) {
      return;
    }

    await this.executeAutoForward(decision);
  }

  private async executeAutoForward(decision: AutoForwardDecision): Promise<void> {
    this.autoForwardSendActive = true;
    this.autoForwardState = this.autoForwardEngine.getState();
    this.emit();

    try {
      const result = await this.bridgeMonitoredMessageToTarget(
        decision.sourceAgent,
        decision.targetAgent,
        decision.sessionId,
        decision.messageId,
        decision.mode,
        "",
        "auto-forward"
      );

      if (result.ok) {
        this.autoForwardEngine.markForwarded(decision);
      } else {
        this.autoForwardEngine.markFailed(decision, result.error || "自动转发失败。");
      }
    } catch (error) {
      this.autoForwardEngine.markFailed(decision, error instanceof Error ? error.message : String(error));
    } finally {
      this.autoForwardState = this.autoForwardEngine.getState();
      this.autoForwardSendActive = false;
      this.emit();
    }
  }

  private pushSystemMessage(text: string): ChatMessage {
    return this.pushMessage({
      id: createId(),
      role: "system",
      text,
      createdAt: Date.now()
    });
  }

  private pushMessage(message: ChatMessage): ChatMessage {
    this.messages.push(message);
    this.emit();
    return message;
  }

  private emit(): void {
    this.changeEmitter.fire(this.getSnapshot());
  }

  private getConfig(): BrokerConfig {
    const config = vscode.workspace.getConfiguration("broker");
    const zcodeDataDir = config.get<string>("zcodeDataDir", "");
    return {
      codexPath: config.get<string>("codexPath", "codex"),
      claudePath: config.get<string>("claudePath", "claude"),
      zcode: {
        dataDir: zcodeDataDir,
        exePath: this.discoveredZcodeExePath
      },
      defaultReturnMode: config.get<ReturnMode>("defaultReturnMode", "compact"),
      defaultAutoDebateRounds: config.get<AutoDebateRounds>("defaultAutoDebateRounds", 1),
      claudePermissionMode: config.get<string>("claudePermissionMode", "default"),
      claudeAllowedTools: config.get<string[]>("claudeAllowedTools", []),
      autoForwardEnabled: config.get<boolean>("autoForwardEnabled", false),
      autoForwardKeywords: normalizeAutoForwardKeywords(
        config.get<unknown>("autoForwardKeywords", DEFAULT_AUTO_FORWARD_KEYWORDS)
      ),
      directionalRolePrefixes: normalizeDirectionalRolePrefixes(
        config.get<unknown>("directionalRolePrefixes", DEFAULT_DIRECTIONAL_ROLE_PREFIXES)
      )
    };
  }

  private getDirectionalRolePrefix(sourceAgent: AgentKind, _target: AgentKind): string {
    const prefixes = this.getConfig().directionalRolePrefixes;
    // sourceAgent 是红方 → 转发给蓝方，套蓝方身份锁（blue 前缀）。
    // sourceAgent 是蓝方 → 转发给红方，套红方身份锁（red 前缀）。
    if (this.pair.red === sourceAgent) {
      return prefixes.blue;
    }
    if (this.pair.blue === sourceAgent) {
      return prefixes.red;
    }
    return "";
  }

  // ---- 红蓝双方桥接对 ----

  public async setBridgePair(red: AgentSelection, blue: AgentSelection): Promise<void> {
    this.pair = { red, blue };
    // 持久化用户意图（保存原始选择，非检测后被清空的值），重启后恢复。
    await vscode.workspace
      .getConfiguration("broker")
      .update("bridgePair", { red, blue }, vscode.ConfigurationTarget.Workspace);
    this.emit();
    await this.checkPair();
    await this.refreshMonitor();
  }

  public async setZcodeDataDir(dataDir: string): Promise<void> {
    await vscode.workspace
      .getConfiguration("broker")
      .update("zcodeDataDir", dataDir, vscode.ConfigurationTarget.Workspace);
    this.emit();
    if (this.pair.red === "zcode" || this.pair.blue === "zcode") {
      await this.checkPair();
    }
  }

  // 用户点击红灯手动触发 ZCode 重新检测（含自动启动 9224）。
  public async recheckZcode(): Promise<void> {
    const slot: "red" | "blue" | undefined =
      this.pair.red === "zcode" ? "red" : this.pair.blue === "zcode" ? "blue" : undefined;
    if (!slot) {
      return;
    }
    this.setSlotStatus(slot, "yellow", "检测中...");
    await this.checkAgentAvailable("zcode", slot, true);  // allowRestart=true：允许 taskkill 重启
    this.emit();
  }

  // 用户主动选择 pair 时触发检测：允许 ZCode 自动重启（allowRestart=true）。
  private async checkPair(): Promise<void> {
    await this.refreshPairCheck(true);
  }

  private async checkAgentAvailable(agent: AgentKind, slot?: "red" | "blue", allowRestart = false): Promise<string | undefined> {
    try {
      if (agent === "codex" || agent === "claude") {
        const commands = await vscode.commands.getCommands(true);
        const required = agent === "codex" ? "chatgpt.openSidebar" : "claude-vscode.focus";
        if (!commands.includes(required)) {
          return `${agent} 官方扩展未安装或未注册命令`;
        }
        return undefined;
      }
      // zcode：自动发现 exe + app-server list 连通性（只 list 不 send）。
      return await this.checkZcodeAvailable(slot, allowRestart);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  // allowRestart=false（启动/轮询时）：只读检测，CDP 不通就报红，绝不杀 ZCode 进程。
  // allowRestart=true（用户主动点红灯/选 ZCode 时）：CDP 不通才允许 taskkill 重启。
  private async checkZcodeAvailable(slot?: "red" | "blue", allowRestart = false): Promise<string | undefined> {
    const updateProgress = (msg: string, status?: PairSlotStatus) => {
      if (status) {
        this.setSlotStatus(slot, status, msg);
      } else if (slot) {
        this.pairCheck[slot] = msg;
        this.emit();
      }
      this.logger?.info(`[zcode-check] ${msg}`);
    };

    // exe 发现：先用持久化路径，没有则提示手动开
    updateProgress("发现 ZCode exe...", "yellow");
    const exePath = await this.discoverZcodeExe();
    if (!exePath) {
      return "未发现 ZCode，第一次请手动打开 ZCode 桌面应用";
    }
    this.discoveredZcodeExePath = exePath;
    updateProgress(`exe: ...${exePath.slice(-25)}`, "yellow");

    const config = this.getConfig();
    if (!config.zcode.dataDir) {
      return "未配置 ZCode 数据目录，请在设置里填写";
    }

    // CDP 可达性：allowRestart=false 时只检测不重启；allowRestart=true 才允许 taskkill 重启。
    updateProgress("检查 CDP 端口 9224...", "yellow");
    if (!(await isCdpReachable())) {
      if (!allowRestart) {
        // 启动/轮询场景：ZCode 在跑但没开 9224，设黄灯（检测到，待点击重启），绝不杀进程。
        this.setSlotStatus(slot, "yellow", "已检测到 ZCode，点击重启开启调试端口");
        return "__pending__";
      }
      updateProgress("CDP 不可达，正在用调试端口重启 ZCode...", "yellow");
      const restartErr = await this.restartZcodeWithDebugPort(exePath, updateProgress);
      if (restartErr) {
        return restartErr;
      }
    }

    updateProgress("验证 app-server + 输入框...", "yellow");
    const adapter = await this.ensureZcodeAdapter();
    if (!adapter) {
      return "ZCode adapter 启动失败";
    }
    await adapter.healthCheck();
    return undefined;
  }

  // 用 --remote-debugging-port=9224 重启 ZCode。
  // 每步通过 onProgress 回调实时报告，方便 UI 显示当前动作。
  private async restartZcodeWithDebugPort(
    exePath: string,
    onProgress: (msg: string) => void
  ): Promise<string | undefined> {
    return new Promise<string | undefined>((resolve) => {
      onProgress("taskkill 关闭现有 ZCode...");
      this.logger?.info(`[zcode-restart] taskkill /IM ZCode.exe /F`);
      // 1. 杀掉所有 ZCode 进程
      execFile("taskkill", ["/IM", "ZCode.exe", "/F"], { windowsHide: true }, (killErr) => {
        if (killErr) {
          this.logger?.info(`[zcode-restart] taskkill 完成（可能无进程）: ${killErr.message}`);
        }
        // 2. 带调试端口重启。
        // 用 cmd /c start 启动：脱离 Broker 父进程（VS Code 退出不带走 ZCode）。
        // 关键修复：清除 ELECTRON_RUN_AS_NODE。VS Code 扩展宿主 process.env.ELECTRON_RUN_AS_NODE=1，
        // 若继承，ZCode.exe 会以 node 模式启动（不开 GUI/9224），~45ms 内 exit 9。
        // 注意：app-server（ZCodeRpcClient）恰恰需要 =1 跑 zcode.cjs，两者相反，由 env 决定。
        setTimeout(() => {
          onProgress(`启动 ZCode（调试端口 9224）...`);
          const exeDir = exePath.replace(/[^\\/]+\.exe$/i, "");
          this.logger?.info(`[zcode-restart] start cwd=${exeDir} exe=${exePath}`);
          // 清理 ELECTRON_RUN_AS_NODE，让 ZCode 以 GUI 模式启动
          const childEnv = { ...process.env };
          delete childEnv.ELECTRON_RUN_AS_NODE;
          let spawnErrorMsg = "";
          let child;
          try {
            // cmd /c start "" "<exe>" <args> ——start 创建独立窗口进程
            child = spawn("cmd", ["/c", "start", "", exePath, "--remote-debugging-port=9224"], {
              cwd: exeDir,
              detached: true,
              stdio: "ignore",
              shell: false,
              windowsHide: false,
              env: childEnv
            });
            child.on("error", (err) => {
              spawnErrorMsg = `ZCode 启动失败: ${err.message}`;
              this.logger?.error(`[zcode-restart] spawn error: ${err.message}`);
            });
            child.on("exit", (code) => {
              // cmd /c start 的退出码是 cmd 本身的，不是 ZCode 的；非 0 才报错
              if (code !== null && code !== 0) {
                spawnErrorMsg = `启动命令退出，code=${code}`;
                this.logger?.error(`[zcode-restart] cmd exit code=${code}`);
              }
            });
            child.unref();
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            this.logger?.error(`[zcode-restart] spawn throw: ${msg}`);
            resolve(`重启 ZCode 失败: ${msg}`);
            return;
          }

          // 3. 轮询等 CDP 就绪（最多等 30 秒，每 2 秒报告进度）
          const deadline = Date.now() + 30000;
          const startTime = Date.now();
          const poll = async () => {
            if (spawnErrorMsg) {
              resolve(spawnErrorMsg);
              return;
            }
            if (await isCdpReachable()) {
              onProgress("CDP 就绪");
              this.logger?.info(`[zcode-restart] CDP ready after ${Date.now() - startTime}ms`);
              resolve(undefined);
              return;
            }
            const elapsed = Math.round((Date.now() - startTime) / 1000);
            if (Date.now() > deadline) {
              const msg = `ZCode 重启后 CDP 端口 9224 仍不可达（等了 30 秒）`;
              this.logger?.error(`[zcode-restart] ${msg}`);
              resolve(msg);
              return;
            }
            onProgress(`等待 ZCode 启动...（${elapsed}s）`);
            setTimeout(poll, 2000);
          };
          setTimeout(poll, 2000);
        }, 2000);
      });
    });
  }

  private discoveredZcodeExePath: string | undefined;

  // 发现 ZCode exe 路径：先读持久化配置，没有再从运行进程命令行抓取，发现后写回配置。
  private async discoverZcodeExe(): Promise<string | undefined> {
    // 1. 先用已发现的内存值
    if (this.discoveredZcodeExePath) {
      return this.discoveredZcodeExePath;
    }
    // 2. 读持久化配置
    const config = vscode.workspace.getConfiguration("broker");
    const saved = config.get<string>("zcodeExePath", "");
    if (saved && this.exePathValid(saved)) {
      this.discoveredZcodeExePath = saved;
      this.logger?.info(`[zcode-discover] 用配置里的 exe: ${saved}`);
      return saved;
    }
    // 3. 从运行进程命令行抓取（精确匹配主窗口进程）
    const discovered = await this.discoverZcodeExeFromProcess();
    if (discovered) {
      this.discoveredZcodeExePath = discovered;
      // 持久化，下次直接用
      await config.update("zcodeExePath", discovered, vscode.ConfigurationTarget.Workspace);
      this.logger?.info(`[zcode-discover] 发现并持久化 exe: ${discovered}`);
    }
    return discovered;
  }

  private exePathValid(p: string): boolean {
    try {
      return require("fs").existsSync(p);
    } catch {
      return false;
    }
  }

  private discoverZcodeExeFromProcess(): Promise<string | undefined> {
    return new Promise<string | undefined>((resolve) => {
      execFile(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          "Get-CimInstance Win32_Process -Filter \"Name='ZCode.exe'\" | Where-Object { $_.CommandLine -and -not ($_.CommandLine -like '*--type=*') -and -not ($_.CommandLine -like '*app-server*') } | Select-Object -First 1 -ExpandProperty CommandLine"
        ],
        { windowsHide: true },
        (error, stdout) => {
          if (error) {
            this.logger?.info(`[zcode-discover] powershell error: ${error.message}`);
            resolve(undefined);
            return;
          }
          const cmdLine = stdout.trim();
          this.logger?.info(`[zcode-discover] cmdLine: ${cmdLine}`);
          if (!cmdLine) {
            resolve(undefined);
            return;
          }
          const match = cmdLine.match(/^"([^"]+\.exe)"/i) || cmdLine.match(/^([^\s]+\.exe)/i);
          const exePath = match?.[1];
          this.logger?.info(`[zcode-discover] resolved exe: ${exePath ?? "(未匹配)"}`);
          resolve(exePath);
        }
      );
    });
  }

  private async ensureZcodeAdapter(): Promise<ZCodeAdapter | undefined> {
    if (this.adapters.zcode) {
      return this.adapters.zcode as ZCodeAdapter;
    }
    const adapter = new ZCodeAdapter(() => this.getConfig(), this.cwd);
    try {
      await adapter.startSession();
    } catch {
      return undefined;
    }
    this.adapters.zcode = adapter;
    return adapter;
  }

  // monitor 注入的 ZCode 读取函数：复用 adapter 的 app-server 连接。
  private async readZCodeMonitoredSession(workspaceCwd: string): Promise<MonitoredSession | undefined> {
    if (this.pair.red !== "zcode" && this.pair.blue !== "zcode") {
      return undefined;
    }
    if (!this.getConfig().zcode.dataDir) {
      return undefined;
    }
    try {
      const adapter = await this.ensureZcodeAdapter();
      if (!adapter) {
        return undefined;
      }
      const sessionId = await adapter.discoverSession(workspaceCwd);
      if (!sessionId) {
        return undefined;
      }
      const session = await adapter.readSession(sessionId);
      return session ?? undefined;
    } catch {
      return undefined;
    }
  }
}

export function normalizeDirectionalRolePrefixes(value: unknown): DirectionalRolePrefixes {
  const empty: DirectionalRolePrefixes = { red: "", blue: "" };
  if (!value || typeof value !== "object") {
    return empty;
  }

  const entry = value as Partial<Record<string, unknown>>;

  // 兼容旧格式 claudeToCodex / codexToClaude → red / blue 迁移。
  if (typeof entry.red === "string" || typeof entry.blue === "string") {
    return {
      red: typeof entry.red === "string" ? entry.red : "",
      blue: typeof entry.blue === "string" ? entry.blue : ""
    };
  }

  // 旧格式：claudeToCodex（给 Codex 的身份锁 → blue 槽），codexToClaude（给 Claude 的身份锁 → red 槽）。
  if (typeof entry.claudeToCodex === "string" || typeof entry.codexToClaude === "string") {
    return {
      red: typeof entry.codexToClaude === "string" ? entry.codexToClaude : "",
      blue: typeof entry.claudeToCodex === "string" ? entry.claudeToCodex : ""
    };
  }

  return empty;
}
