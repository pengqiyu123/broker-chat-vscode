import * as fs from "fs";
import * as http from "http";
import * as readline from "readline";
import {
  BrokerRuntimeInfo,
  fingerprintWorkspace,
  getBrokerRuntimeFilePath
} from "./brokerRuntime";
import { AgentKind } from "../types";

interface JsonRpcRequest {
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

interface SidecarOptions {
  source: AgentKind;
  workspace: string;
}

interface BrokerForwardArguments {
  target: AgentKind;
  content: string;
  requestId: string;
  mode: "message";
}

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

const SERVER_INFO = { name: "broker-chat-forward", version: "0.3.0" };
const MAX_CONTENT_CHARS = 20000;

export function parseSidecarArgs(argv: string[]): SidecarOptions {
  const getValue = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    if (index === -1) {
      return undefined;
    }
    return argv[index + 1];
  };

  const source = getValue("--source");
  const workspace = getValue("--workspace") || getValue("--broker-workspace");
  if (!isAgentKind(source)) {
    throw new Error("--source must be one of codex, claude, zcode.");
  }
  if (!workspace || !workspace.trim()) {
    throw new Error("--workspace is required.");
  }
  return { source, workspace };
}

export function createBrokerForwardTool(): Record<string, unknown> {
  return {
    name: "broker_forward",
    description:
      "Forward one explicit user-approved message to another local Broker Chat agent. Use only when the user clearly asks to send/forward content to Codex, ClaudeCode, or ZCode. One call sends one message; do not create loops.",
    inputSchema: {
      type: "object",
      properties: {
        target: {
          type: "string",
          enum: ["codex", "claude", "zcode"],
          description: "The target agent to receive the forwarded content."
        },
        content: {
          type: "string",
          description: "The exact content to forward."
        },
        requestId: {
          type: "string",
          description: "A stable unique id for this forwarding request."
        },
        mode: {
          type: "string",
          enum: ["message"],
          description: "Forwarding mode. Only message is supported."
        }
      },
      required: ["target", "content", "requestId"],
      additionalProperties: false
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  };
}

export function normalizeBrokerForwardArguments(value: unknown): BrokerForwardArguments {
  if (!value || typeof value !== "object") {
    throw new Error("Tool arguments must be a JSON object.");
  }

  const record = value as Record<string, unknown>;
  if (!isAgentKind(record.target)) {
    throw new Error("target must be one of codex, claude, zcode.");
  }
  if (typeof record.content !== "string" || !record.content.trim()) {
    throw new Error("content must be a non-empty string.");
  }
  if (record.content.length > MAX_CONTENT_CHARS) {
    throw new Error(`content is too long; max ${MAX_CONTENT_CHARS} characters.`);
  }
  if (typeof record.requestId !== "string" || !/^[A-Za-z0-9._:-]{6,120}$/.test(record.requestId)) {
    throw new Error("requestId must be 6-120 characters using letters, numbers, dot, underscore, colon, or dash.");
  }
  if (record.mode !== undefined && record.mode !== "message") {
    throw new Error("Only mode=message is supported.");
  }

  return {
    target: record.target,
    content: record.content.trim(),
    requestId: record.requestId,
    mode: "message"
  };
}

export async function callBrokerForward(options: SidecarOptions, args: BrokerForwardArguments): Promise<ToolResult> {
  const runtime = readRuntimeInfo(options.workspace);
  if (runtime.workspaceFingerprint !== fingerprintWorkspace(options.workspace)) {
    throw new Error("Broker runtime file belongs to a different workspace.");
  }

  const response = await postJson(runtime, "/agent-command", {
    workspaceFingerprint: runtime.workspaceFingerprint,
    sourceAgent: options.source,
    target: args.target,
    content: args.content,
    requestId: args.requestId
  });

  const text = response.ok
    ? `BROKER_FORWARD_OK:${args.requestId}:${response.message ?? "sent"}`
    : `BROKER_FORWARD_FAILED:${args.requestId}:${response.error ?? "unknown error"}`;

  return {
    content: [{ type: "text", text }],
    isError: !response.ok
  };
}

export function readRuntimeInfo(workspace: string): BrokerRuntimeInfo {
  const runtimePath = getBrokerRuntimeFilePath(workspace);
  if (!fs.existsSync(runtimePath)) {
    throw new Error(`Broker runtime file not found: ${runtimePath}. Open Broker Chat in VS Code first.`);
  }
  const parsed = JSON.parse(fs.readFileSync(runtimePath, "utf8")) as BrokerRuntimeInfo;
  if (!parsed || parsed.version !== 1 || typeof parsed.port !== "number" || typeof parsed.token !== "string") {
    throw new Error(`Broker runtime file is invalid: ${runtimePath}`);
  }
  return parsed;
}

async function handleMessage(options: SidecarOptions, message: JsonRpcRequest): Promise<void> {
  const { id, method, params } = message;
  if (method === "initialize") {
    sendResult(id, {
      protocolVersion: getProtocolVersion(params),
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO
    });
    return;
  }

  if (method === "notifications/initialized") {
    return;
  }

  if (method === "tools/list") {
    sendResult(id, { tools: [createBrokerForwardTool()] });
    return;
  }

  if (method === "tools/call") {
    try {
      const callParams = params && typeof params === "object" ? params as Record<string, unknown> : {};
      if (callParams.name !== "broker_forward") {
        throw new Error("Unknown tool name.");
      }
      const args = normalizeBrokerForwardArguments(callParams.arguments);
      const result = await callBrokerForward(options, args);
      sendResult(id, result);
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      sendResult(id, {
        content: [{ type: "text", text: `BROKER_FORWARD_FAILED:${messageText}` }],
        isError: true
      });
    }
    return;
  }

  sendError(id, -32601, `Unsupported method: ${method ?? "(missing)"}`);
}

function postJson(runtime: BrokerRuntimeInfo, path: string, payload: unknown): Promise<Record<string, any>> {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port: runtime.port,
        path,
        method: "POST",
        headers: {
          authorization: `Bearer ${runtime.token}`,
          "content-type": "application/json; charset=utf-8",
          "content-length": Buffer.byteLength(body)
        }
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          try {
            resolve(JSON.parse(text) as Record<string, any>);
          } catch {
            reject(new Error(`Broker control endpoint returned invalid JSON, status=${response.statusCode}.`));
          }
        });
      }
    );
    request.on("error", reject);
    request.write(body);
    request.end();
  });
}

function getProtocolVersion(params: unknown): string {
  if (params && typeof params === "object") {
    const value = (params as Record<string, unknown>).protocolVersion;
    if (typeof value === "string") {
      return value;
    }
  }
  return "2025-06-18";
}

function sendResult(id: JsonRpcRequest["id"], result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function sendError(id: JsonRpcRequest["id"], code: number, message: string): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

function isAgentKind(value: unknown): value is AgentKind {
  return value === "codex" || value === "claude" || value === "zcode";
}

async function main(): Promise<void> {
  const options = parseSidecarArgs(process.argv.slice(2));
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    if (!line.trim()) {
      return;
    }
    let parsed: JsonRpcRequest;
    try {
      parsed = JSON.parse(line) as JsonRpcRequest;
    } catch {
      sendError(null, -32700, "Invalid JSON.");
      return;
    }
    void handleMessage(options, parsed);
  });
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
