import { AdapterCallbacks, AgentAdapter, AdapterSendRequest, BrokerConfig, ChatRole, MonitoredSession } from "../types";
import { killProcessTree, normalizePath, createId } from "../utils";
import {
  ZCodeRpcClient,
  ZCodeListResult,
  ZCodeListSession,
  ZCodeReadResult,
  ZCodeReadMessage
} from "./ZCodeRpcClient";
import { cdpSendToZCodeInput, isCdpReachable } from "./ZCodeCdpClient";

const POLL_INTERVAL_MS = 1500;

// ZCode 消息正文在 parts[].text（type 为 text/reasoning 等），拼接所有 text part。
function extractZCodeMessageText(message: ZCodeReadMessage): string {
  if (Array.isArray(message.parts) && message.parts.length > 0) {
    const textParts = message.parts
      .map((p) => (p && typeof p.text === "string" && p.type !== "reasoning" ? p.text : ""))
      .filter(Boolean);
    if (textParts.length > 0) {
      return textParts.join("\n");
    }
  }
  // 兼容旧字段
  if (typeof message.content === "string") {
    return message.content;
  }
  return "";
}

// ZCode harness 注入的噪声识别：框架自动塞进 user/assistant 的 system-reminder、
// TodoWrite 提醒、上下文快照等，不是用户真正说的话。这些消息整条都是模板，可安全丢弃。
// 判定必须是「以模板开头」（不是包含），避免误杀引用这些模板的真实消息。
const HARNESS_NOISE_PREFIXES = [
  "The TodoWrite tool hasn't been used",
  "<system-reminder>",
  "The user wants",
  "As you answer the user's questions",
];

function isZCodeHarnessNoise(text: string): boolean {
  const trimmed = text.trimStart();
  if (!trimmed) {
    return false;
  }
  return HARNESS_NOISE_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

export class ZCodeAdapter implements AgentAdapter {
  public readonly kind = "zcode" as const;

  private client?: ZCodeRpcClient;
  private sessionId = createId();
  private stopped = false;
  private currentCallbacks?: AdapterCallbacks;
  private readTimer?: NodeJS.Timeout;
  private targetSessionId?: string;
  private lastReadCount = 0;
  private completed = false;

  public constructor(private readonly configProvider: () => BrokerConfig, private readonly cwd: string) {}

  public async startSession(): Promise<string> {
    await this.ensureClient();
    return this.sessionId;
  }

  private async ensureClient(): Promise<ZCodeRpcClient> {
    if (this.client && this.client.isRunning) {
      return this.client;
    }

    const config = this.configProvider();
    const exePath = config.zcode.exePath;
    const dataDir = config.zcode.dataDir;
    if (!exePath) {
      throw new Error("ZCode exe path not discovered. Ensure ZCode desktop app is running.");
    }
    if (!dataDir) {
      throw new Error("ZCode data dir not configured. Set broker.zcodeDataDir in settings.");
    }

    // app-server 入口脚本与 exe 同级：resources/glm/zcode.cjs
    const scriptPath = exePath.replace(/ZCode\.exe$/i, "resources/glm/zcode.cjs");
    const client = new ZCodeRpcClient(exePath, scriptPath);
    await client.start();
    this.client = client;
    return client;
  }

  // 健康检查：验 app-server 连接 + CDP 端口可达。绝不触发 send。
  public async healthCheck(): Promise<void> {
    const client = await this.ensureClient();
    const result = await client.request<ZCodeListResult>("session/list", {});
    if (!result || !Array.isArray(result.sessions)) {
      throw new Error("session/list 未返回 sessions 字段");
    }
    if (!(await isCdpReachable())) {
      throw new Error("ZCode CDP 端口 9224 不可达（需带 --remote-debugging-port=9224 启动 ZCode）");
    }
  }

  // 会话发现：session/list 返回 { sessions: [...] } → workspace 过滤 → 取最近 updatedAt。
  // 过滤不到 → 退化取全局最近。见 docs/send-method-test-log.md ZC-DUP-001 / 会话隔离观察。
  public async discoverSession(workspaceCwd?: string): Promise<string | null> {
    const client = await this.ensureClient();
    const result = await client.request<ZCodeListResult>("session/list", {});
    const sessions = Array.isArray(result?.sessions) ? result.sessions : [];
    if (sessions.length === 0) {
      return null;
    }

    const targetWorkspace = normalizePath(workspaceCwd ?? this.cwd);
    const matching = targetWorkspace
      ? sessions.filter((s) => normalizePath(s.workspace?.workspacePath) === targetWorkspace)
      : [];
    const pool = matching.length > 0 ? matching : sessions;

    pool.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    const latest = pool[0];
    return latest?.sessionId ?? null;
  }

  // 读取会话消息（供 monitor 复用同一个 client）。
  // 用 session/resume（能读任意会话历史）；session/read 只能读 active 会话。
  public async readSession(sessionId: string): Promise<MonitoredSession | null> {
    const client = await this.ensureClient();
    const result = await client.request<ZCodeReadResult>("session/resume", { sessionId });
    const messages = Array.isArray(result?.messages) ? result.messages : [];
    if (messages.length === 0) {
      return null;
    }

    return this.mapToMonitoredSession(sessionId, messages);
  }

  private mapToMonitoredSession(sessionId: string, messages: ZCodeReadMessage[]): MonitoredSession {
    // 按轮聚合：user 开新一轮，连续 tool-calls 合并成一条过程卡，stop 单独一条。
    const chatMessages: Array<{
      id: string;
      role: ChatRole;
      text: string;
      createdAt: number;
      meta: Record<string, string | number | boolean>;
    }> = [];

    let turnStartIndex = -1; // 当前轮的起始 message index（用于稳定 id）
    let processSteps: Array<{ text: string; created: number; index: number }> = [];

    const flushProcess = () => {
      if (processSteps.length === 0) {
        return;
      }
      const validSteps = processSteps.filter((s) => s.text.trim().length > 0);
      const stepCount = processSteps.length;
      const text = validSteps.map((s) => s.text).join("\n\n---\n\n");
      const created = processSteps[0].created;
      chatMessages.push({
        id: `monitor:zcode:${sessionId}:${turnStartIndex}-process`,
        role: "zcode",
        text: text || `(运行了 ${stepCount} 个中间步骤)`,
        createdAt: created,
        meta: {
          zcodeProcess: true,
          zcodeStepCount: stepCount
        }
      });
      processSteps = [];
    };

    messages.forEach((message, index) => {
      const role: ChatRole = message.info?.role === "user" ? "user" : "zcode";
      const finish = message.info?.finish;
      const text = extractZCodeMessageText(message);
      const created = typeof message.info?.time?.created === "number" ? message.info!.time!.created! : Date.now();

      // harness 噪声消息（TodoWrite 提醒、system-reminder 等）整条丢弃，不计入任何卡片。
      if (isZCodeHarnessNoise(text)) {
        return;
      }

      if (role === "user") {
        // user 开新一轮：先冲掉上一轮未闭合的过程卡
        flushProcess();
        turnStartIndex = index;
        processSteps = [];
        if (text.trim()) {
          chatMessages.push({
            id: `monitor:zcode:${sessionId}:${index}`,
            role: "user",
            text,
            createdAt: created,
            meta: {}
          });
        }
        return;
      }

      // assistant：stop 是总结，单独一条；tool-calls/其他 收进过程卡
      if (finish === "stop") {
        flushProcess();
        if (text.trim()) {
          chatMessages.push({
            id: `monitor:zcode:${sessionId}:${index}`,
            role: "zcode",
            text,
            createdAt: created,
            meta: {
              zcodeComplete: true,
              zcodeFinish: "stop"
            }
          });
        }
        if (turnStartIndex === -1) {
          turnStartIndex = index;
        }
      } else {
        // tool-calls 中间步骤：累积到过程卡
        if (turnStartIndex === -1) {
          turnStartIndex = index;
        }
        processSteps.push({ text, created, index });
      }
    });
    // 末尾若仍有未闭合的过程（轮还没 stop，正在运行）
    flushProcess();

    return {
      agent: "zcode",
      sessionId,
      title: `ZCode ${sessionId.slice(0, 8)}`,
      sourcePath: `zcode-appserver:${sessionId}`,
      updatedAt: Date.now(),
      messageCount: chatMessages.length,
      messages: chatMessages
    };
  }

  public async sendMessage(request: AdapterSendRequest, callbacks: AdapterCallbacks): Promise<void> {
    await this.startSession();
    this.currentCallbacks = callbacks;
    this.stopped = false;
    this.completed = false;

    const config = this.configProvider();
    if (!config.zcode.dataDir) {
      callbacks.onError(new Error("ZCode data dir not configured."));
      return;
    }

    // 发送通道：CDP（app-server 的 session/send 不触发 AI 回复，已废弃）。
    // CDP 注入的是 ZCode 桌面窗口当前打开的会话。
    if (!(await isCdpReachable())) {
      callbacks.onError(new Error("ZCode CDP 端口不可达，请确保 ZCode 带 --remote-debugging-port=9224 启动。"));
      return;
    }

    // 记录发送前的会话消息数，作为轮询回复的基线。
    try {
      const sessionId = await this.discoverSession(this.cwd);
      if (sessionId) {
        this.targetSessionId = sessionId;
        const client = await this.ensureClient();
        const baseline = await client.request<ZCodeReadResult>("session/resume", { sessionId });
        this.lastReadCount = Array.isArray(baseline?.messages) ? baseline.messages.length : 0;
      }
    } catch {
      // 基线获取失败不阻断发送
    }

    try {
      await cdpSendToZCodeInput(request.text);
      this.startPollingReply();
    } catch (error) {
      callbacks.onError(error as Error, (error as Error).message);
    }
  }

  private startPollingReply(): void {
    this.stopPolling();
    const poll = async () => {
      if (this.stopped || this.completed || !this.targetSessionId || !this.currentCallbacks) {
        return;
      }
      try {
        const client = await this.ensureClient();
        const result = await client.request<ZCodeReadResult>("session/resume", {
          sessionId: this.targetSessionId
        });
        const messages = Array.isArray(result?.messages) ? result.messages : [];

        // 增量输出新消息
        for (let i = this.lastReadCount; i < messages.length; i++) {
          const message = messages[i];
          if (message.info?.role === "assistant") {
            const text = extractZCodeMessageText(message);
            if (text) {
              this.currentCallbacks.onTextDelta(text);
            }
          }
        }
        this.lastReadCount = messages.length;

        // 完成判定：最后一条 assistant 消息 finish === "stop"
        const lastAssistant = [...messages].reverse().find((m) => m.info?.role === "assistant");
        if (lastAssistant && lastAssistant.info?.finish === "stop") {
          this.completed = true;
          this.stopPolling();
          this.currentCallbacks.onComplete();
        }
      } catch {
        // 单次轮询失败不致命，下一轮重试
      }
    };

    void poll();
    this.readTimer = setInterval(() => {
      void poll();
    }, POLL_INTERVAL_MS);
  }

  private stopPolling(): void {
    if (this.readTimer) {
      clearInterval(this.readTimer);
      this.readTimer = undefined;
    }
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    this.stopPolling();
  }

  public async dispose(): Promise<void> {
    this.stopPolling();
    await this.stop();
    await this.client?.stop();
    this.client = undefined;
  }
}
