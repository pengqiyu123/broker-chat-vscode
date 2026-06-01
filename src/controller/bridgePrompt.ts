import { AgentKind, ChatMessage } from "../types";
import { otherAgent } from "../utils";

export type MonitoredBridgeMode = "merge-forward" | "forward-answer";

export interface LatestModelMessage {
  message: ChatMessage;
  messageIndex: number;
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
  let prompt = `${sourceLabel}说：\n${message.text.trim()}`;

  if (mode === "merge-forward") {
    const relatedUser = findAdjacentUserMessage(messages, messageIndex);
    if (!relatedUser) {
      return {
        ok: false,
        target,
        error: "这条回复前没有找到可合并的用户问题。"
      };
    }

    prompt = `User question:\n${relatedUser.text.trim()}\n\n${sourceLabel} answer:\n${message.text.trim()}`;
  }

  return {
    ok: true,
    target,
    prompt: appendBridgeExtraText(prompt, extraText)
  };
}

export function findLatestModelMessage(messages: ChatMessage[], sourceAgent: AgentKind): LatestModelMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === sourceAgent && message.text.trim()) {
      return {
        message,
        messageIndex: index
      };
    }
  }

  return undefined;
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
