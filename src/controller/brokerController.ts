import * as vscode from "vscode";
import {
  AgentAdapter,
  AgentKind,
  AutoDebateRounds,
  AutoDebateState,
  BrokerConfig,
  BrokerSnapshot,
  ChatMessage,
  MessageAction,
  ReturnMode,
  UsageSummary
} from "../types";
import { createId, otherAgent } from "../utils";
import { ClaudeAdapter } from "../adapters/ClaudeAdapter";
import { CodexAdapter } from "../adapters/codexAdapter";
import { OfficialUiBridge } from "../automation/OfficialUiBridge";
import { OfficialTranscriptMonitor } from "../monitor/OfficialTranscriptMonitor";

export class BrokerController implements vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<BrokerSnapshot>();
  private readonly messages: ChatMessage[] = [];
  private readonly adapters: Record<AgentKind, AgentAdapter>;
  private readonly transcriptMonitor: OfficialTranscriptMonitor;
  private readonly uiBridge = new OfficialUiBridge();
  private readonly pollTimer: NodeJS.Timeout;
  private monitorSnapshot = {
    enabled: true,
    lastUpdated: 0
  } as BrokerSnapshot["monitor"];
  private bridgeState: BrokerSnapshot["bridge"] = {
    busy: false
  };

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

  public constructor(private readonly cwd: string) {
    this.transcriptMonitor = new OfficialTranscriptMonitor(this.cwd);
    this.adapters = {
      codex: new CodexAdapter(() => this.getConfig(), cwd),
      claude: new ClaudeAdapter(() => this.getConfig(), cwd)
    };
    this.pollTimer = setInterval(() => {
      void this.refreshMonitor();
    }, 1500);
    void this.refreshMonitor();
  }

  public get onDidChange(): vscode.Event<BrokerSnapshot> {
    return this.changeEmitter.event;
  }

  public getSnapshot(): BrokerSnapshot {
    return {
      workspaceCwd: this.cwd,
      currentTarget: this.currentTarget,
      busy: this.busy,
      autoDebate: {
        active: this.autoDebateState.active,
        rounds: this.autoDebateState.rounds,
        returnMode: this.autoDebateState.returnMode,
        startTarget: this.autoDebateState.startTarget,
        currentStep: this.autoDebateState.currentStep,
        totalSteps: this.autoDebateState.totalSteps
      },
      monitor: this.monitorSnapshot,
      bridge: this.bridgeState
    };
  }

  public async refreshMonitor(): Promise<void> {
    this.monitorSnapshot = await this.transcriptMonitor.readSnapshot();
    this.emit();
  }

  public async bridgeMonitoredMessage(
    sourceAgent: AgentKind,
    sessionId: string,
    messageId: string,
    mode: "merge-forward" | "forward-answer",
    extraText = ""
  ): Promise<void> {
    if (this.bridgeState.busy) {
      this.bridgeState = {
        ...this.bridgeState,
        error: "已有一条桥接发送正在进行，请稍后重试。",
        updatedAt: Date.now(),
        busy: false
      };
      this.emit();
      return;
    }

    const session = sourceAgent === "codex" ? this.monitorSnapshot.codex : this.monitorSnapshot.claude;
    if (!session || session.sessionId !== sessionId) {
      this.bridgeState = {
        busy: false,
        source: sourceAgent,
        mode,
        error: "监控数据已经刷新，请重试这条消息。",
        updatedAt: Date.now()
      };
      this.emit();
      return;
    }

    const messageIndex = session.messages.findIndex((entry) => entry.id === messageId);
    if (messageIndex === -1) {
      this.bridgeState = {
        busy: false,
        source: sourceAgent,
        mode,
        error: "未找到要桥接的消息。",
        updatedAt: Date.now()
      };
      this.emit();
      return;
    }

    const message = session.messages[messageIndex];
    if (!message || message.role !== sourceAgent) {
      this.bridgeState = {
        busy: false,
        source: sourceAgent,
        mode,
        error: "只有模型回复可以桥接发送。",
        updatedAt: Date.now()
      };
      this.emit();
      return;
    }

    const target = otherAgent(sourceAgent);
    const sourceLabel = sourceAgent === "codex" ? "Codex" : "ClaudeCode";
    let prompt = `${sourceLabel}说：\n${message.text.trim()}`;

    if (mode === "merge-forward") {
      const relatedUser = this.findAdjacentMonitoredUserMessage(session.messages, messageIndex);
      if (!relatedUser) {
        this.bridgeState = {
          busy: false,
          source: sourceAgent,
          target,
          mode,
          error: "这条回复前没有找到可合并的用户问题。",
          updatedAt: Date.now()
        };
        this.emit();
        return;
      }

      prompt = `User question:\n${relatedUser.text.trim()}\n\n${sourceLabel} answer:\n${message.text.trim()}`;
    }

    prompt = this.appendBridgeExtraText(prompt, extraText);

    this.bridgeState = {
      busy: true,
      source: sourceAgent,
      target,
      mode,
      message: `正在桥接到 ${target === "codex" ? "Codex" : "Claude"}...`,
      updatedAt: Date.now()
    };
    this.emit();

    try {
      const result = await this.uiBridge.sendToAgent(target, prompt);
      this.bridgeState = {
        busy: false,
        source: sourceAgent,
        target,
        mode,
        message: result,
        updatedAt: Date.now()
      };
    } catch (error) {
      this.bridgeState = {
        busy: false,
        source: sourceAgent,
        target,
        mode,
        error: error instanceof Error ? error.message : String(error),
        updatedAt: Date.now()
      };
    }

    this.emit();
  }

  public setCurrentTarget(target: AgentKind): void {
    this.currentTarget = target;
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
        if (payload?.target === "codex" || payload?.target === "claude") {
          this.currentTarget = payload.target;
          this.emit();
        }
        break;
      case "approval-approve":
      case "approval-deny":
        if (message.role === "approval" && message.approval) {
          await this.adapters.codex.resolveApproval?.(
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
      await Promise.all([this.adapters.codex.stop(), this.adapters.claude.stop()]);
      this.busy = false;
      this.autoDebateState.active = false;
      this.pushSystemMessage("Active response stopped.");
    }
    await this.refreshMonitor();
    this.emit();
  }

  public async newSession(): Promise<void> {
    await Promise.all([this.adapters.codex.dispose(), this.adapters.claude.dispose()]);
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
    void this.adapters.codex.dispose();
    void this.adapters.claude.dispose();
  }

  private findAdjacentMonitoredUserMessage(messages: ChatMessage[], fromIndex: number): ChatMessage | undefined {
    const candidate = messages[fromIndex - 1];
    if (candidate?.role === "user" && candidate.text.trim()) {
      return candidate;
    }
    return undefined;
  }

  private appendBridgeExtraText(prompt: string, extraText: string): string {
    const trimmedExtraText = extraText.trim();
    if (!trimmedExtraText) {
      return prompt;
    }

    return `${prompt}\n\nAdditional user note:\n${trimmedExtraText}`;
  }

  private async forwardMerged(message: ChatMessage): Promise<void> {
    const target = otherAgent(message.role as AgentKind);
    const relatedUser = this.findRelatedUserMessage(message);
    if (!relatedUser) {
      this.pushSystemMessage("No related user message was found for merge-forward.");
      return;
    }

    const sourceLabel = message.role === "codex" ? "Codex" : "ClaudeCode";
    const prompt = `User question:\n${relatedUser.text}\n\n${sourceLabel} answer:\n${message.text}\n\nPlease continue from this context.`;
    await this.runAgent(target, prompt, {
      replyToUserMessageId: relatedUser.id,
      isFirstResponseToUserMessage: false,
      isAutoDebateStep: false,
      requestText: prompt
    });
  }

  private async forwardAnswerOnly(message: ChatMessage): Promise<void> {
    const target = otherAgent(message.role as AgentKind);
    const sourceLabel = message.role === "codex" ? "Codex" : "ClaudeCode";
    const prompt = `${sourceLabel}说：\n${message.text}`;
    await this.runAgent(target, prompt, {
      replyToUserMessageId: message.replyToUserMessageId,
      isFirstResponseToUserMessage: false,
      isAutoDebateStep: false,
      requestText: prompt,
      plainTextOnly: true
    });
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

    const nextTarget = otherAgent(target);
    const nextPrompt = this.buildAutoDebatePrompt(nextTarget, responseMessage);
    await this.runAutoDebateStep(nextTarget, nextPrompt, userMessageId, stepIndex + 1);
  }

  private buildAutoDebatePrompt(nextTarget: AgentKind, sourceMessage: ChatMessage): string {
    const userMessage = this.findRelatedUserMessage(sourceMessage);
    const userText = userMessage?.text ?? "";
    const sourceLabel = sourceMessage.role === "codex" ? "Codex" : "Claude";
    const targetLabel = nextTarget === "codex" ? "Codex" : "Claude";
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

    await this.adapters[target].sendMessage(
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
      payload: { target: otherAgent(message.role) }
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
    return {
      codexPath: config.get<string>("codexPath", "codex"),
      claudePath: config.get<string>("claudePath", "claude"),
      defaultReturnMode: config.get<ReturnMode>("defaultReturnMode", "compact"),
      defaultAutoDebateRounds: config.get<AutoDebateRounds>("defaultAutoDebateRounds", 1),
      claudePermissionMode: config.get<string>("claudePermissionMode", "default"),
      claudeAllowedTools: config.get<string[]>("claudeAllowedTools", [])
    };
  }
}
