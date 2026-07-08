import * as fs from "fs";
import * as http from "http";
import * as crypto from "crypto";
import {
  AgentInvokedForwardRequest,
  AgentInvokedForwardResult,
  AgentKind
} from "../types";
import {
  BrokerRuntimeInfo,
  fingerprintWorkspace,
  getBrokerRuntimeDir,
  getBrokerRuntimeFilePath
} from "./brokerRuntime";
import type { BrokerLogger } from "../automation/BrokerLogger";

const MAX_BODY_BYTES = 256 * 1024;

export type AgentCommandHandler = (request: AgentInvokedForwardRequest) => Promise<AgentInvokedForwardResult>;

export class BrokerControlServer {
  private server?: http.Server;
  private runtimeInfo?: BrokerRuntimeInfo;
  private readonly token = crypto.randomBytes(32).toString("hex");

  public constructor(
    private readonly workspaceCwd: string,
    private readonly handler: AgentCommandHandler,
    private readonly logger?: BrokerLogger
  ) {}

  public async start(): Promise<BrokerRuntimeInfo> {
    if (this.runtimeInfo) {
      return this.runtimeInfo;
    }

    const server = http.createServer((request, response) => {
      void this.handleRequest(request, response);
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("Broker MCP control server did not bind to a TCP port.");
    }

    this.server = server;
    this.runtimeInfo = {
      version: 1,
      workspaceCwd: this.workspaceCwd,
      workspaceFingerprint: fingerprintWorkspace(this.workspaceCwd),
      port: address.port,
      token: this.token,
      pid: process.pid,
      updatedAt: Date.now()
    };
    this.writeRuntimeFile(this.runtimeInfo);
    this.logger?.info(
      `[mcp-control] listening on 127.0.0.1:${address.port} runtime=${getBrokerRuntimeFilePath(this.workspaceCwd)}`
    );
    return this.runtimeInfo;
  }

  public getRuntimeInfo(): BrokerRuntimeInfo | undefined {
    return this.runtimeInfo ? { ...this.runtimeInfo } : undefined;
  }

  public dispose(): void {
    if (this.server) {
      this.server.close();
      this.server = undefined;
    }
    this.runtimeInfo = undefined;
    try {
      fs.rmSync(getBrokerRuntimeFilePath(this.workspaceCwd), { force: true });
    } catch {
      // Runtime cleanup is best effort; stale files are rejected by token/port checks.
    }
  }

  private async handleRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    try {
      if (request.method === "GET" && request.url === "/health") {
        this.sendJson(response, 200, {
          ok: true,
          workspaceFingerprint: this.runtimeInfo?.workspaceFingerprint
        });
        return;
      }

      if (request.method !== "POST" || request.url !== "/agent-command") {
        this.sendJson(response, 404, { ok: false, error: "Unknown Broker control endpoint." });
        return;
      }

      if (!this.isAuthorized(request)) {
        this.sendJson(response, 401, { ok: false, error: "Unauthorized Broker control request." });
        return;
      }

      const body = await this.readBody(request);
      const parsed = JSON.parse(body) as unknown;
      const command = this.parseAgentCommand(parsed);
      if (!command.ok) {
        this.sendJson(response, 400, { ok: false, error: command.error });
        return;
      }

      const result = await this.handler(command.request);
      this.sendJson(response, result.ok ? 200 : 409, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger?.error(`[mcp-control] request failed: ${message}`);
      this.sendJson(response, 500, { ok: false, error: message });
    }
  }

  private parseAgentCommand(value: unknown): { ok: true; request: AgentInvokedForwardRequest } | { ok: false; error: string } {
    if (!value || typeof value !== "object") {
      return { ok: false, error: "Request body must be a JSON object." };
    }

    const record = value as Record<string, unknown>;
    const runtime = this.runtimeInfo;
    if (!runtime || record.workspaceFingerprint !== runtime.workspaceFingerprint) {
      return { ok: false, error: "Workspace fingerprint does not match this Broker instance." };
    }

    if (!isAgentKind(record.sourceAgent) || !isAgentKind(record.target)) {
      return { ok: false, error: "sourceAgent and target must be valid Broker agents." };
    }
    if (typeof record.content !== "string" || typeof record.requestId !== "string") {
      return { ok: false, error: "content and requestId must be strings." };
    }
    if (record.sourceSessionId !== undefined && typeof record.sourceSessionId !== "string") {
      return { ok: false, error: "sourceSessionId must be a string when provided." };
    }

    return {
      ok: true,
      request: {
        sourceAgent: record.sourceAgent,
        sourceSessionId: record.sourceSessionId,
        target: record.target,
        content: record.content,
        requestId: record.requestId
      }
    };
  }

  private isAuthorized(request: http.IncomingMessage): boolean {
    const auth = request.headers.authorization;
    return typeof auth === "string" && auth === `Bearer ${this.token}`;
  }

  private readBody(request: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          reject(new Error("Broker control request body is too large."));
          request.destroy();
          return;
        }
        chunks.push(chunk);
      });
      request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      request.on("error", reject);
    });
  }

  private sendJson(response: http.ServerResponse, statusCode: number, payload: unknown): void {
    const body = JSON.stringify(payload);
    response.writeHead(statusCode, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body)
    });
    response.end(body);
  }

  private writeRuntimeFile(info: BrokerRuntimeInfo): void {
    fs.mkdirSync(getBrokerRuntimeDir(this.workspaceCwd), { recursive: true });
    fs.writeFileSync(getBrokerRuntimeFilePath(this.workspaceCwd), JSON.stringify(info, null, 2), "utf8");
  }
}

function isAgentKind(value: unknown): value is AgentKind {
  return value === "codex" || value === "claude" || value === "zcode";
}
