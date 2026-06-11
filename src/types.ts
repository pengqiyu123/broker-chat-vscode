export type AgentKind = "codex" | "claude";
export type FocusIdentifiedAgent = AgentKind | "detector" | "unknown";
export type ChatRole = "user" | AgentKind | "system" | "approval";
export type ReturnMode = "compact" | "full";
export type AutoDebateRounds = 1 | 2 | 3;
export type AutoForwardStatus = "disabled" | "idle" | "waiting" | "sending" | "sent" | "failed";

export interface AutoForwardKeywords {
  codex: string[];
  claude: string[];
}

export interface FocusElementSnapshot {
  name: string;
  className: string;
  automationId: string;
  controlType: string;
  frameworkId: string;
  processId: number;
}

export interface FocusProbeResult {
  currentElement?: FocusElementSnapshot;
  parentChain: FocusElementSnapshot[];
  timestamp: number;
}

export interface FocusIdentification extends FocusProbeResult {
  identifiedAgent: FocusIdentifiedAgent;
  rule: string;
  currentSummary: string;
  chainSummary: string;
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

export interface DirectionalRolePrefixes {
  claudeToCodex: string;
  codexToClaude: string;
}

export const DEFAULT_DIRECTIONAL_ROLE_PREFIXES: DirectionalRolePrefixes = {
  claudeToCodex:
    "身份锁定：你是Codex，首席开发负责人，统领多智能体开发小组，负责全部代码实现。\n上级对接：ClaudeCode为本项目产品经理，只下发开发指令、验收成果、提出修改意见，你严格按照ClaudeCode的指令开发。",
  codexToClaude:
    "身份：你是ClaudeCode，本项目专职产品经理，统筹多智能体开发项目，不编写代码，只拆解需求、输出开发指令、验收Codex开发成果、下发整改要求。\n协作关系：Codex为首席开发主管，带队多智能体团队编码落地，严格按你的指令开发。"
};

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
  directionalRolePrefixes: DirectionalRolePrefixes;
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
    | "save-auto-forward-keywords"
    | "save-directional-role-prefixes";
  sourceAgent?: AgentKind;
  sessionId?: string;
  messageId?: string;
  mode?: "merge-forward" | "forward-answer";
  extraText?: string;
  autoForwardEnabled?: boolean;
  autoForwardKeywords?: AutoForwardKeywords;
  directionalRolePrefixes?: DirectionalRolePrefixes;
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
  directionalRolePrefixes: DirectionalRolePrefixes;
}
