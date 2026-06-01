import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

interface ApiEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

type AgentKind = "codex" | "claude";
type BridgeMode = "merge-forward" | "forward-answer";

interface BrokerSendResponse {
  message: string;
  snapshot?: unknown;
}

interface BrokerForwardLatestResponse {
  message: string;
  source?: AgentKind;
  target?: AgentKind;
  mode?: BridgeMode;
  sessionId?: string;
  messageId?: string;
  snapshot?: unknown;
}

const HOST = "127.0.0.1";
const DEFAULT_PORT = 14711;
const REQUEST_TIMEOUT_MS = 30_000;

const server = new McpServer({
  name: "broker-chat-mcp-server",
  version: "0.0.1"
});

server.registerTool(
  "broker_get_status",
  {
    title: "Get Broker Chat Status",
    description:
      "Return the active Broker Chat workspace, local MCP HTTP server status, bridge status, and compact monitor status. Use this before sending to confirm the correct workspace_cwd.",
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  async () => {
    try {
      const status = await postBroker<unknown>("/api/status", {});
      const compactStatus = compactBrokerStatus(status);
      return toolResult(compactStatus);
    } catch (error) {
      return toolError(error);
    }
  }
);

server.registerTool(
  "broker_send_to_agent",
  {
    title: "Send Text Through Broker Chat",
    description:
      "Directly send explicit text to the official Codex or Claude Code VS Code panel through Broker Chat. Keep this for raw commands or user-provided text. If you just produced a normal official reply and want to forward that reply with the same format as the Broker UI button, use broker_forward_latest_reply instead.",
    inputSchema: {
      target: z.enum(["codex", "claude"]).describe("Official agent panel to receive the text."),
      text: z.string().min(1).max(100_000).describe("Text to paste and submit through the official panel."),
      workspace_cwd: z.string().min(1).describe("Workspace path returned by broker_get_status for the intended Broker window.")
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false
    }
  },
  async (params: { target: AgentKind; text: string; workspace_cwd: string }) => {
    try {
      const response = await postBroker<BrokerSendResponse>("/api/send", {
        target: params.target,
        text: params.text,
        workspaceCwd: params.workspace_cwd
      });
      return toolResult({
        message: response.message,
        snapshot: compactBrokerStatus(response.snapshot)
      });
    } catch (error) {
      return toolError(error);
    }
  }
);

server.registerTool(
  "broker_forward_latest_reply",
  {
    title: "Forward Latest Official Reply",
    description:
      "After you have already answered normally in the official Codex or Claude Code chat, trigger Broker Chat to forward the latest monitored model reply using the same formatting and bridge path as the Broker UI transfer buttons. This tool does not accept message text.",
    inputSchema: {
      source_agent: z.enum(["codex", "claude"]).describe("Official agent whose latest reply should be forwarded."),
      workspace_cwd: z.string().min(1).describe("Workspace path returned by broker_get_status for the intended Broker window."),
      mode: z
        .enum(["forward-answer", "merge-forward"])
        .optional()
        .describe("Use forward-answer for the same format as the '仅转发这条回答' button, or merge-forward for the adjacent user question plus answer."),
      extra_text: z.string().max(20_000).optional().describe("Optional note appended exactly like the Broker UI note field."),
      after_message_id: z
        .string()
        .min(1)
        .optional()
        .describe("Optional previous latest message id from broker_get_status. When set, Broker waits for a newer reply before forwarding."),
      wait_ms: z
        .number()
        .int()
        .min(0)
        .max(30_000)
        .optional()
        .describe("How long Broker should wait for a newer monitored reply when after_message_id is provided. Defaults to 5000.")
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false
    }
  },
  async (params: {
    source_agent: AgentKind;
    workspace_cwd: string;
    mode?: BridgeMode;
    extra_text?: string;
    after_message_id?: string;
    wait_ms?: number;
  }) => {
    try {
      const response = await postBroker<BrokerForwardLatestResponse>("/api/forward-latest", {
        sourceAgent: params.source_agent,
        workspaceCwd: params.workspace_cwd,
        mode: params.mode ?? "forward-answer",
        extraText: params.extra_text ?? "",
        afterMessageId: params.after_message_id,
        waitMs: params.wait_ms ?? 5000
      });
      return toolResult({
        message: response.message,
        source: response.source,
        target: response.target,
        mode: response.mode,
        sessionId: response.sessionId,
        messageId: response.messageId,
        snapshot: compactBrokerStatus(response.snapshot)
      });
    } catch (error) {
      return toolError(error);
    }
  }
);

async function postBroker<T>(route: string, body: unknown): Promise<T> {
  const token = readBrokerToken();
  const payload = JSON.stringify(body);
  const port = getBrokerPort();

  return new Promise<T>((resolve, reject) => {
    const request = http.request(
      {
        host: HOST,
        port,
        path: route,
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload)
        }
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let envelope: ApiEnvelope<T>;
          try {
            envelope = JSON.parse(raw) as ApiEnvelope<T>;
          } catch {
            reject(new Error(`Broker returned an invalid response with HTTP ${response.statusCode ?? "unknown"}.`));
            return;
          }

          if (!envelope.ok) {
            reject(new Error(envelope.error || `Broker returned HTTP ${response.statusCode ?? "unknown"}.`));
            return;
          }

          resolve(envelope.data as T);
        });
      }
    );

    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.destroy(new Error("Broker request timed out."));
    });

    request.on("error", (error) => {
      reject(new Error(`Broker HTTP API is not reachable on ${HOST}:${port}. Open Broker Chat in VS Code. ${error.message}`));
    });

    request.write(payload);
    request.end();
  });
}

function readBrokerToken(): string {
  const envToken = process.env.BROKER_TOKEN?.trim();
  if (envToken) {
    return envToken;
  }

  const tokenPath = path.join(os.homedir(), ".broker-chat", "mcp-token");
  try {
    const token = fs.readFileSync(tokenPath, "utf8").trim();
    if (token) {
      return token;
    }
  } catch {
    // Fall through to the user-facing error below.
  }

  throw new Error("Broker token was not found. Open Broker Chat in VS Code once to create ~/.broker-chat/mcp-token.");
}

function getBrokerPort(): number {
  const rawPort = process.env.BROKER_PORT;
  if (!rawPort) {
    return DEFAULT_PORT;
  }

  const port = Number(rawPort);
  if (Number.isInteger(port) && port > 0 && port <= 65535) {
    return port;
  }

  throw new Error("BROKER_PORT must be an integer between 1 and 65535.");
}

function compactBrokerStatus(value: unknown): Record<string, unknown> {
  if (!isObject(value)) {
    return {
      value
    };
  }

  const monitor = isObject(value.monitor) ? value.monitor : undefined;
  return {
    workspaceCwd: value.workspaceCwd,
    bridge: value.bridge,
    server: value.server,
    monitor: monitor
      ? {
          enabled: monitor.enabled,
          lastUpdated: monitor.lastUpdated,
          codexError: monitor.codexError,
          claudeError: monitor.claudeError,
          codex: compactSession(monitor.codex),
          claude: compactSession(monitor.claude)
        }
      : undefined
  };
}

function compactSession(value: unknown): Record<string, unknown> | undefined {
  if (!isObject(value)) {
    return undefined;
  }

  return {
    agent: value.agent,
    sessionId: value.sessionId,
    title: value.title,
    cwd: value.cwd,
    updatedAt: value.updatedAt,
    messageCount: value.messageCount,
    latestModelMessage: compactLatestModelMessage(value.messages, value.agent)
  };
}

function compactLatestModelMessage(messages: unknown, agent: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(messages) || (agent !== "codex" && agent !== "claude")) {
    return undefined;
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isObject(message) || message.role !== agent || typeof message.text !== "string" || !message.text.trim()) {
      continue;
    }

    return {
      id: message.id,
      createdAt: message.createdAt,
      preview: message.text.trim().slice(0, 240)
    };
  }

  return undefined;
}

function toolResult(data: Record<string, unknown>) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data, null, 2)
      }
    ],
    structuredContent: data
  };
}

function toolError(error: unknown) {
  const message = error instanceof Error && error.message ? error.message : String(error);
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: `Error: ${message}`
      }
    ]
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Broker Chat MCP server running over stdio.");
}

void main().catch((error) => {
  const message = error instanceof Error && error.message ? error.message : String(error);
  console.error(`Broker Chat MCP server failed: ${message}`);
  process.exit(1);
});
