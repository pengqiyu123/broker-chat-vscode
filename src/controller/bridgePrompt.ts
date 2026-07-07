import { AgentKind, ChatMessage, DirectionalRolePrefixes } from "../types";

export type MonitoredBridgeMode = "merge-forward" | "forward-answer";

function agentLabel(agent: AgentKind): string {
  if (agent === "codex") {
    return "Codex";
  }
  if (agent === "claude") {
    return "ClaudeCode";
  }
  return "ZCode";
}

export interface MonitoredBridgePromptSuccess {
  ok: true;
  target: AgentKind;
  prompt: string;
}

export interface MonitoredBridgePromptFailure {
  ok: false;
  target?: AgentKind;
  error: string;
}

export type MonitoredBridgePromptResult = MonitoredBridgePromptSuccess | MonitoredBridgePromptFailure;

// 前缀选择已由 controller 按 pair 红蓝槽位完成（red 前缀=红方身份锁，blue 前缀=蓝方身份锁）。
// 此函数保留导出以兼容测试脚本，但不再做方向推断；返回空，真正的前缀由调用方传入 directionalPrefix。
export function getDirectionalRolePrefix(
  _sourceAgent: AgentKind,
  _target: AgentKind,
  _prefixes: DirectionalRolePrefixes
): string {
  return "";
}

export function buildBridgeAnswerPrompt(
  sourceAgent: AgentKind,
  target: AgentKind,
  text: string,
  extraText = "",
  directionalPrefix = ""
): MonitoredBridgePromptResult {
  const trimmedText = text.trim();
  if (!trimmedText) {
    return {
      ok: false,
      target,
      error: "回答正文不能为空。"
    };
  }

  const sourceLabel = agentLabel(sourceAgent);
  return {
    ok: true,
    target,
    prompt: prependDirectionalPrefix(
      appendBridgeExtraText(`${sourceLabel}说：\n${trimmedText}`, extraText),
      directionalPrefix
    )
  };
}

export function buildMonitoredBridgePrompt(
  sourceAgent: AgentKind,
  target: AgentKind,
  messages: ChatMessage[],
  messageIndex: number,
  mode: MonitoredBridgeMode,
  extraText = "",
  directionalPrefix = ""
): MonitoredBridgePromptResult {
  const message = messages[messageIndex];

  if (!message || message.role !== sourceAgent) {
    return {
      ok: false,
      target,
      error: "只有模型回复可以桥接发送。"
    };
  }

  const sourceLabel = agentLabel(sourceAgent);
  if (mode === "forward-answer") {
    return buildBridgeAnswerPrompt(sourceAgent, target, message.text, extraText, directionalPrefix);
  }

  if (!message.text.trim()) {
    return {
      ok: false,
      target,
      error: "回答正文不能为空。"
    };
  }

  const relatedUser = findAdjacentUserMessage(messages, messageIndex);
  if (!relatedUser) {
    return {
      ok: false,
      target,
      error: "这条回复前没有找到可合并的用户问题。"
    };
  }

  return {
    ok: true,
    target,
    prompt: prependDirectionalPrefix(
      appendBridgeExtraText(
        `User question:\n${relatedUser.text.trim()}\n\n${sourceLabel} answer:\n${message.text.trim()}`,
        extraText
      ),
      directionalPrefix
    )
  }
}

function findAdjacentUserMessage(messages: ChatMessage[], fromIndex: number): ChatMessage | undefined {
  const candidate = messages[fromIndex - 1];
  if (candidate?.role === "user" && candidate.text.trim()) {
    return candidate;
  }
  return undefined;
}

function appendBridgeExtraText(prompt: string, extraText: string): string {
  const trimmedExtraText = extraText.trim();
  if (!trimmedExtraText) {
    return prompt;
  }

  return `${prompt}\n\nAdditional user note:\n${trimmedExtraText}`;
}

function prependDirectionalPrefix(prompt: string, directionalPrefix: string): string {
  const trimmedPrefix = directionalPrefix.trim();
  if (!trimmedPrefix) {
    return prompt;
  }

  return `${trimmedPrefix}\n\n${prompt}`;
}
