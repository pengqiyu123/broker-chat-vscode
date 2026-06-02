export type AgentKind = "codex" | "claude";
export type ChatRole = "user" | AgentKind | "system" | "approval";
export type ReturnMode = "compact" | "full";
export type AutoDebateRounds = 1 | 2 | 3;
export type AutoForwardStatus = "disabled" | "idle" | "waiting" | "sending" | "sent" | "failed";

export interface AutoForwardKeywords {
  codex: string[];
  claude: string[];
}

export interface UsageSummary {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  totalCostUsd?: number;
}

export interface MessageAction {
  kind:
    | "merge-forward"
    | "forward-answer"
    | "continue-current"
    | "switch-target"
    | "approval-approve"
    | "approval-deny"
    | "approval-details"
    | "retry-claude"
    | "retry-claude-plain";
  label: string;
  payload?: Record<string, string | number | boolean>;
}

export interface ApprovalState {
  agent: "codex";
  requestId: string;
  method: string;
  title: string;
  detail: string;
  rawParams: unknown;
  resolved: boolean;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  thinking?: string;
  createdAt: number;
  pending?: boolean;
  error?: boolean;
  actions?: MessageAction[];
  approval?: ApprovalState;
  replyToUserMessageId?: string;
  isFirstResponseToUserMessage?: boolean;
  isAutoDebateStep?: boolean;
  sourceAgent?: AgentKind;
  usage?: UsageSummary;
  meta?: Record<string, string | number | boolean>;
}

export interface AutoDebateState {
  active: boolean;
  startTarget: AgentKind;
  rounds: AutoDebateRounds;
  returnMode: ReturnMode;
  userMessageId: string;
  currentStep: number;
  totalSteps: number;
  currentPrompt: string;
  currentSourceMessageId?: string;
}

export interface BrokerSnapshot {
  workspaceCwd?: string;
  currentTarget: AgentKind;
  busy: boolean;
  autoDebate: {
    active: boolean;
    rounds: AutoDebateRounds;
    returnMode: ReturnMode;
    startTarget: AgentKind;
    currentStep: number;
    totalSteps: number;
  };
  monitor: OfficialMonitorSnapshot;
  bridge: BridgeStatus;
  autoForward: AutoForwardState;
}

export interface MonitoredSession {
  agent: AgentKind;
  sessionId: string;
  title: string;
  cwd?: string;
  sourcePath: string;
  updatedAt: number;
  messageCount: number;
  messages: ChatMessage[];
}

export interface OfficialMonitorSnapshot {
  enabled: boolean;
  lastUpdated: number;
  codex?: MonitoredSession;
  claude?: MonitoredSession;
  codexError?: string;
  claudeError?: string;
}

export interface PreferredMonitorSession {
  agent: AgentKind;
  sessionId: string;
  sourcePath?: string;
}

export interface BridgeStatus {
  busy: boolean;
  target?: AgentKind;
  source?: AgentKind;
  mode?: "merge-forward" | "forward-answer";
  message?: string;
  error?: string;
  updatedAt?: number;
}

export interface AutoForwardState {
  enabled: boolean;
  status: AutoForwardStatus;
  source?: AgentKind;
  target?: AgentKind;
  keyword?: string;
  keywords?: AutoForwardKeywords;
  userMessageId?: string;
  replyMessageId?: string;
  message?: string;
  error?: string;
  updatedAt?: number;
}

export interface WebviewInboundMessage {
  type:
    | "ready"
    | "refresh-monitor"
    | "bridge-send"
    | "show-logs"
    | "toggle-auto-forward"
    | "save-auto-forward-keywords";
  sourceAgent?: AgentKind;
  sessionId?: string;
  messageId?: string;
  mode?: "merge-forward" | "forward-answer";
  extraText?: string;
  autoForwardEnabled?: boolean;
  autoForwardKeywords?: AutoForwardKeywords;
}

export interface WebviewOutboundMessage {
  type: "snapshot" | "focus-input";
  snapshot?: BrokerSnapshot;
}

export interface AdapterSendRequest {
  text: string;
  plainTextOnly?: boolean;
}

export interface AdapterCallbacks {
  onTextDelta: (delta: string) => void;
  onThinkingDelta?: (delta: string) => void;
  onApproval?: (approval: ApprovalState) => void;
  onSystemMessage?: (text: string) => void;
  onComplete: (usage?: UsageSummary) => void;
  onError: (error: Error, detail?: string) => void;
}

export interface AgentAdapter {
  readonly kind: AgentKind;
  startSession(): Promise<string>;
  sendMessage(request: AdapterSendRequest, callbacks: AdapterCallbacks): Promise<void>;
  stop(): Promise<void>;
  dispose(): Promise<void>;
  resolveApproval?(requestId: string, decision: "approve" | "deny"): Promise<void>;
}

export interface BrokerConfig {
  codexPath: string;
  claudePath: string;
  defaultReturnMode: ReturnMode;
  defaultAutoDebateRounds: AutoDebateRounds;
  claudePermissionMode: string;
  claudeAllowedTools: string[];
  autoForwardEnabled: boolean;
  autoForwardKeywords: AutoForwardKeywords;
}
