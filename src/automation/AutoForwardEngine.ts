import {
  AgentKind,
  AutoForwardKeywords,
  AutoForwardState,
  ChatMessage,
  MonitoredSession,
  OfficialMonitorSnapshot
} from "../types";

const KEYWORD_EDGE_CHARS = 40;
const TRAILING_TRIGGER_PUNCTUATION = /[\s:：。.!！?？"'“”'‘’)\]）】]+$/u;

export const DEFAULT_AUTO_FORWARD_KEYWORDS: AutoForwardKeywords = {
  codex: [
    "给Codex命令",
    "给codex命令",
    "发送给codex",
    "发给codex",
    "转给codex",
    "转发给codex",
    "问codex",
    "给 Codex",
    "发送给 Codex",
    "发给 Codex",
    "转给 Codex",
    "转发给 Codex",
    "问 Codex"
  ],
  claude: [
    "回复ClaudeCode",
    "回复claudecode",
    "给ClaudeCode命令",
    "给claudecode命令",
    "发送给claude",
    "发给claude",
    "转给claude",
    "转发给claude",
    "问claude",
    "给 Claude",
    "发送给 Claude",
    "发给 Claude",
    "转给 Claude",
    "转发给 Claude",
    "问 Claude"
  ]
};

export interface AutoForwardConfig {
  enabled: boolean;
  keywords: AutoForwardKeywords;
}

export interface AutoForwardDecision {
  sourceAgent: AgentKind;
  targetAgent: AgentKind;
  sessionId: string;
  userMessageId: string;
  messageId: string;
  keyword: string;
  mode: "forward-answer";
}

interface PendingAutoForward {
  sourceAgent: AgentKind;
  targetAgent: AgentKind;
  sessionId: string;
  sourcePath?: string;
  userMessageId: string;
  userMessageIndex: number;
  keyword: string;
  detectedAt: number;
  stableCount: number;
  lastReplySignature?: string;
  replyMessageId?: string;
}

interface TriggerCandidate {
  session: MonitoredSession;
  userMessage: ChatMessage;
  userMessageIndex: number;
  targetAgent: AgentKind;
  keyword: string;
}

export class AutoForwardEngine {
  private readonly now: () => number;
  private initialized = false;
  private pending: PendingAutoForward | undefined;
  private readonly seenUserMessageIds = new Set<string>();
  private readonly handledUserMessageIds = new Set<string>();
  private state: AutoForwardState = {
    enabled: true,
    status: "idle"
  };

  public constructor(options?: { now?: () => number }) {
    this.now = options?.now ?? Date.now;
  }

  public evaluate(monitor: OfficialMonitorSnapshot, config: AutoForwardConfig): AutoForwardDecision | undefined {
    const normalizedConfig = normalizeAutoForwardConfig(config);
    if (!normalizedConfig.enabled) {
      this.resetBaseline(monitor, false);
      return undefined;
    }

    if (!this.initialized) {
      this.resetBaseline(monitor, true);
      return undefined;
    }

    if (this.pending) {
      return this.evaluatePending(monitor);
    }

    const trigger = this.findLatestTrigger(monitor, normalizedConfig.keywords);
    this.markSeenUsers(monitor);

    if (!trigger) {
      this.state = {
        enabled: true,
        status: "idle",
        updatedAt: this.now()
      };
      return undefined;
    }

    this.pending = {
      sourceAgent: trigger.session.agent,
      targetAgent: trigger.targetAgent,
      sessionId: trigger.session.sessionId,
      sourcePath: trigger.session.sourcePath,
      userMessageId: trigger.userMessage.id,
      userMessageIndex: trigger.userMessageIndex,
      keyword: trigger.keyword,
      detectedAt: this.now(),
      stableCount: 0
    };
    this.state = this.buildWaitingState("等待模型最终回复。");
    return this.evaluatePending(monitor);
  }

  public getState(): AutoForwardState {
    return { ...this.state };
  }

  public getPendingSession(): { agent: AgentKind; sessionId: string; sourcePath?: string } | undefined {
    if (!this.pending) {
      return undefined;
    }

    return {
      agent: this.pending.sourceAgent,
      sessionId: this.pending.sessionId,
      sourcePath: this.pending.sourcePath
    };
  }

  public resetBaseline(monitor: OfficialMonitorSnapshot, enabled = true): void {
    this.initialized = true;
    this.pending = undefined;
    this.seenUserMessageIds.clear();
    this.markSeenUsers(monitor);
    this.state = {
      enabled,
      status: enabled ? "idle" : "disabled",
      message: enabled ? undefined : "自动转发已关闭。",
      updatedAt: this.now()
    };
  }

  public markForwarded(decision: AutoForwardDecision | undefined): void {
    if (!decision) {
      return;
    }

    this.handledUserMessageIds.add(decision.userMessageId);
    this.pending = undefined;
    this.state = {
      enabled: true,
      status: "sent",
      source: decision.sourceAgent,
      target: decision.targetAgent,
      keyword: decision.keyword,
      userMessageId: decision.userMessageId,
      replyMessageId: decision.messageId,
      message: "自动转发已完成。",
      updatedAt: this.now()
    };
  }

  public markFailed(decision: AutoForwardDecision | undefined, error: string): void {
    if (decision) {
      this.handledUserMessageIds.add(decision.userMessageId);
    }

    this.pending = undefined;
    this.state = {
      enabled: true,
      status: "failed",
      source: decision?.sourceAgent,
      target: decision?.targetAgent,
      keyword: decision?.keyword,
      userMessageId: decision?.userMessageId,
      replyMessageId: decision?.messageId,
      error,
      updatedAt: this.now()
    };
  }

  private evaluatePending(monitor: OfficialMonitorSnapshot): AutoForwardDecision | undefined {
    const pending = this.pending;
    if (!pending) {
      return undefined;
    }

    const session = pending.sourceAgent === "codex" ? monitor.codex : monitor.claude;
    if (!session || session.sessionId !== pending.sessionId) {
      this.state = this.buildWaitingState("等待匹配的官方会话刷新。");
      return undefined;
    }

    const reply = this.findLatestReplyAfter(session, pending.userMessageIndex);
    if (!reply) {
      this.state = this.buildWaitingState("等待模型回复。");
      return undefined;
    }

    pending.replyMessageId = reply.message.id;
    const replySignature = this.buildReplySignature(session, reply.message);
    if (replySignature === pending.lastReplySignature) {
      pending.stableCount += 1;
    } else {
      pending.lastReplySignature = replySignature;
      pending.stableCount = 1;
    }

    const complete = this.isReplyComplete(pending.sourceAgent, reply.message, pending.stableCount);
    this.state = complete
      ? {
          ...this.buildWaitingState("准备自动转发。"),
          status: "sending",
          replyMessageId: reply.message.id
        }
      : {
          ...this.buildWaitingState("等待模型最终回复。"),
          replyMessageId: reply.message.id
        };

    if (!complete) {
      return undefined;
    }

    return {
      sourceAgent: pending.sourceAgent,
      targetAgent: pending.targetAgent,
      sessionId: pending.sessionId,
      userMessageId: pending.userMessageId,
      messageId: reply.message.id,
      keyword: pending.keyword,
      mode: "forward-answer"
    };
  }

  private findLatestTrigger(
    monitor: OfficialMonitorSnapshot,
    keywords: AutoForwardKeywords
  ): TriggerCandidate | undefined {
    const candidates: TriggerCandidate[] = [];

    for (const session of [monitor.codex, monitor.claude]) {
      if (!session) {
        continue;
      }

      session.messages.forEach((message, messageIndex) => {
        if (message.role !== "user" || this.seenUserMessageIds.has(message.id) || this.handledUserMessageIds.has(message.id)) {
          return;
        }

        const match = matchAutoForwardKeyword(message.text, keywords);
        if (!match) {
          return;
        }
        if (match.target === session.agent) {
          this.seenUserMessageIds.add(message.id);
          return;
        }

        candidates.push({
          session,
          userMessage: message,
          userMessageIndex: messageIndex,
          targetAgent: match.target,
          keyword: match.keyword
        });
      });
    }

    candidates.sort((left, right) => {
      if (left.userMessage.createdAt !== right.userMessage.createdAt) {
        return right.userMessage.createdAt - left.userMessage.createdAt;
      }
      return right.userMessageIndex - left.userMessageIndex;
    });

    return candidates[0];
  }

  private findLatestReplyAfter(
    session: MonitoredSession,
    userMessageIndex: number
  ): { message: ChatMessage; messageIndex: number } | undefined {
    for (let index = session.messages.length - 1; index > userMessageIndex; index -= 1) {
      const message = session.messages[index];
      if (message?.role === session.agent && message.text.trim()) {
        return {
          message,
          messageIndex: index
        };
      }
    }

    return undefined;
  }

  private isReplyComplete(sourceAgent: AgentKind, message: ChatMessage, stableCount: number): boolean {
    if (sourceAgent === "claude") {
      const stopReason = typeof message.meta?.stopReason === "string" ? message.meta.stopReason : undefined;
      if (stopReason === "end_turn") {
        return true;
      }
      if (stopReason && stopReason !== "end_turn") {
        return false;
      }
    }

    if (sourceAgent === "codex") {
      if (message.meta?.codexComplete === true) {
        return true;
      }

      return message.meta?.codexHasTurnEvents !== true && message.meta?.codexLegacyStable === true && stableCount >= 2;
    }

    return false;
  }

  private buildReplySignature(session: MonitoredSession, message: ChatMessage): string {
    return `${session.sessionId}:${session.messageCount}:${message.id}:${message.text.length}:${message.text}`;
  }

  private buildWaitingState(message: string): AutoForwardState {
    const pending = this.pending;
    return {
      enabled: true,
      status: "waiting",
      source: pending?.sourceAgent,
      target: pending?.targetAgent,
      keyword: pending?.keyword,
      userMessageId: pending?.userMessageId,
      replyMessageId: pending?.replyMessageId,
      message,
      updatedAt: this.now()
    };
  }

  private markSeenUsers(monitor: OfficialMonitorSnapshot): void {
    for (const session of [monitor.codex, monitor.claude]) {
      if (!session) {
        continue;
      }
      for (const message of session.messages) {
        if (message.role === "user") {
          this.seenUserMessageIds.add(message.id);
        }
      }
    }
  }
}

export function normalizeAutoForwardConfig(config: AutoForwardConfig): AutoForwardConfig {
  return {
    enabled: Boolean(config.enabled),
    keywords: normalizeAutoForwardKeywords(config.keywords)
  };
}

export function normalizeAutoForwardKeywords(value: unknown): AutoForwardKeywords {
  if (!isObject(value)) {
    return cloneDefaultKeywords();
  }

  return {
    codex: normalizeKeywordList(value.codex, DEFAULT_AUTO_FORWARD_KEYWORDS.codex),
    claude: normalizeKeywordList(value.claude, DEFAULT_AUTO_FORWARD_KEYWORDS.claude)
  };
}

export function matchAutoForwardKeyword(
  text: string,
  keywords: AutoForwardKeywords
): { target: AgentKind; keyword: string } | undefined {
  const normalizedHead = normalizeText(text).slice(0, KEYWORD_EDGE_CHARS);
  const normalizedTail = normalizeTailText(text).slice(-KEYWORD_EDGE_CHARS);
  for (const target of ["codex", "claude"] as const) {
    for (const keyword of keywords[target]) {
      const normalizedKeyword = normalizeKeyword(keyword);
      if (normalizedKeyword && matchesEdgeKeyword(normalizedHead, normalizedTail, normalizedKeyword)) {
        return {
          target,
          keyword
        };
      }
    }
  }

  return undefined;
}

function normalizeKeywordList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) {
    return [...fallback];
  }

  const normalized = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);

  return normalized.length > 0 ? [...new Set(normalized)] : [...fallback];
}

function cloneDefaultKeywords(): AutoForwardKeywords {
  return {
    codex: [...DEFAULT_AUTO_FORWARD_KEYWORDS.codex],
    claude: [...DEFAULT_AUTO_FORWARD_KEYWORDS.claude]
  };
}

function normalizeText(value: string): string {
  return value.trimStart().toLowerCase();
}

function normalizeTailText(value: string): string {
  return value.trimEnd().toLowerCase();
}

function normalizeKeyword(value: string): string {
  return value.trim().toLowerCase();
}

function matchesEdgeKeyword(headText: string, tailText: string, keyword: string): boolean {
  if (headText.startsWith(keyword)) {
    return true;
  }

  return trimTriggerPunctuation(tailText).endsWith(keyword);
}

function trimTriggerPunctuation(value: string): string {
  return value.replace(TRAILING_TRIGGER_PUNCTUATION, "");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
