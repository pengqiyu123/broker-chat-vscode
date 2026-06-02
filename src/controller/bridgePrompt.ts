import { AgentKind, ChatMessage } from "../types";
import { otherAgent } from "../utils";

export type MonitoredBridgeMode = "merge-forward" | "forward-answer";

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

export function buildBridgeAnswerPrompt(
  sourceAgent: AgentKind,
  target: AgentKind,
  text: string,
  extraText = ""
): MonitoredBridgePromptResult {
  const trimmedText = text.trim();
  if (!trimmedText) {
    return {
      ok: false,
      target,
      error: "回答正文不能为空。"
    };
  }

  const sourceLabel = sourceAgent === "codex" ? "Codex" : "ClaudeCode";
  return {
    ok: true,
    target,
    prompt: appendBridgeExtraText(`${sourceLabel}说：\n${trimmedText}`, extraText)
  };
}

export function buildMonitoredBridgePrompt(
  sourceAgent: AgentKind,
  messages: ChatMessage[],
  messageIndex: number,
  mode: MonitoredBridgeMode,
  extraText = ""
): MonitoredBridgePromptResult {
  const message = messages[messageIndex];
  const target = otherAgent(sourceAgent);

  if (!message || message.role !== sourceAgent) {
    return {
      ok: false,
      target,
      error: "只有模型回复可以桥接发送。"
    };
  }

  const sourceLabel = sourceAgent === "codex" ? "Codex" : "ClaudeCode";
  if (mode === "forward-answer") {
    return buildBridgeAnswerPrompt(sourceAgent, target, message.text, extraText);
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
    prompt: appendBridgeExtraText(
      `User question:\n${relatedUser.text.trim()}\n\n${sourceLabel} answer:\n${message.text.trim()}`,
      extraText
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
