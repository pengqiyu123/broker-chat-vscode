import { ChildProcess } from "child_process";
import * as readline from "readline";
import { AdapterCallbacks, AdapterSendRequest, AgentAdapter, BrokerConfig, UsageSummary } from "../types";
import { createId, extractTextContent, killProcessTree, spawnCli } from "../utils";

interface ClaudeStreamLine {
  type?: string;
  subtype?: string;
  event?: {
    type?: string;
    delta?: {
      type?: string;
      text?: string;
      thinking?: string;
    };
  };
  message?: {
    content?: unknown;
  };
  result?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
  };
  total_cost_usd?: number;
}

export class ClaudeAdapter implements AgentAdapter {
  public readonly kind = "claude" as const;

  private sessionId = createId();
  private activeProcess?: ChildProcess;
  private stopped = false;

  public constructor(private readonly configProvider: () => BrokerConfig, private readonly cwd: string) {}

  public async startSession(): Promise<string> {
    return this.sessionId;
  }

  public async sendMessage(request: AdapterSendRequest, callbacks: AdapterCallbacks): Promise<void> {
    await this.startSession();
    const config = this.configProvider();
    const args = [
      "-p",
      "--verbose",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--session-id",
      this.sessionId,
      "--permission-mode",
      config.claudePermissionMode
    ];

    if (config.claudeAllowedTools.length > 0) {
      args.push("--allowedTools", config.claudeAllowedTools.join(","));
    }

    args.push(request.text);

    this.stopped = false;
    let completed = false;
    let fallbackText = "";
    const child = spawnCli(config.claudePath, args, {
      cwd: this.cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    this.activeProcess = child;
    const stdout = child.stdout;
    const stderr = child.stderr;
    if (!stdout || !stderr) {
      callbacks.onError(new Error("Claude process did not expose stdout/stderr pipes."));
      return;
    }
    stdout.setEncoding("utf8");
    stderr.setEncoding("utf8");

    const stderrChunks: string[] = [];
    const rl = readline.createInterface({ input: stdout });

    const parseUsage = (line: ClaudeStreamLine): UsageSummary | undefined => {
      const usage = line.usage;
      if (!usage && typeof line.total_cost_usd !== "number") {
        return undefined;
      }

      return {
        inputTokens: usage?.input_tokens,
        outputTokens: usage?.output_tokens,
        cacheReadTokens: usage?.cache_read_input_tokens,
        totalCostUsd: line.total_cost_usd
      };
    };

    rl.on("line", (rawLine) => {
      const line = rawLine.trim();
      if (!line) {
        return;
      }

      let parsed: ClaudeStreamLine;
      try {
        parsed = JSON.parse(line) as ClaudeStreamLine;
      } catch {
        return;
      }

      if (parsed.type === "stream_event" && parsed.event?.type === "content_block_delta" && parsed.event.delta?.type === "text_delta" && parsed.event.delta.text) {
        fallbackText += parsed.event.delta.text;
        callbacks.onTextDelta(parsed.event.delta.text);
        return;
      }

      if (parsed.type === "stream_event" && parsed.event?.type === "content_block_delta" && parsed.event.delta?.type === "thinking_delta" && parsed.event.delta.thinking) {
        callbacks.onThinkingDelta?.(parsed.event.delta.thinking);
        return;
      }

      if (parsed.type === "assistant") {
        const fullText = extractTextContent(parsed.message?.content);
        if (fullText && !fallbackText) {
          fallbackText = fullText;
          callbacks.onTextDelta(fullText);
        }
        return;
      }

      if (parsed.type === "result") {
        completed = true;
        if (parsed.subtype === "success") {
          callbacks.onComplete(parseUsage(parsed));
        } else {
          const detail = typeof parsed.result === "string" ? parsed.result : "Claude returned an error result.";
          callbacks.onError(new Error(detail), detail);
        }
      }
    });

    stderr.on("data", (chunk: string) => {
      stderrChunks.push(chunk);
    });

    await new Promise<void>((resolve) => {
      child.once("close", (code) => {
        rl.close();
        this.activeProcess = undefined;
        if (!completed && !this.stopped) {
          const detail = stderrChunks.join("").trim();
          callbacks.onError(
            new Error(detail || `Claude process exited with code ${code ?? "unknown"}.`),
            detail || undefined
          );
        }
        resolve();
      });

      child.once("error", (error) => {
        rl.close();
        this.activeProcess = undefined;
        if (!completed) {
          callbacks.onError(error, error.message);
        }
        resolve();
      });
    });
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    await killProcessTree(this.activeProcess);
    this.activeProcess = undefined;
  }

  public async dispose(): Promise<void> {
    await this.stop();
  }
}
