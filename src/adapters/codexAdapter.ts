import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { ChildProcess } from "child_process";
import { AdapterCallbacks, AdapterSendRequest, AgentAdapter, ApprovalState, BrokerConfig } from "../types";
import { createId, killProcessTree, spawnCli } from "../utils";
import { CodexRpcClient } from "./CodexRpcClient";

interface PendingApproval {
  requestId: string;
  method: string;
  params: Record<string, unknown>;
}

export class CodexAdapter implements AgentAdapter {
  public readonly kind = "codex" as const;

  private rpcClient?: CodexRpcClient;
  private threadId?: string;
  private currentTurnId?: string;
  private currentCallbacks?: AdapterCallbacks;
  private currentText = "";
  private pendingApprovals = new Map<string, PendingApproval>();
  private fallbackChild?: ChildProcess;
  private fallbackMode = false;
  private stopped = false;
  private sessionId = createId();

  public constructor(private readonly configProvider: () => BrokerConfig, private readonly cwd: string) {}

  public async startSession(): Promise<string> {
    if (this.threadId || this.fallbackMode) {
      return this.threadId ?? this.sessionId;
    }

    try {
      const client = new CodexRpcClient(this.configProvider, this.cwd);
      await client.start();
      client.onNotification((notification) => this.handleNotification(notification.method, notification.params));
      client.onRequest((request) => this.handleServerRequest(request.id, request.method, request.params));

      await client.request("initialize", {
        clientInfo: {
          name: "broker-chat-vscode",
          version: "0.0.1"
        },
        capabilities: null
      });
      client.notify("initialized");

      const response = await client.request<{ thread: { id: string } }>("thread/start", {
        cwd: this.cwd,
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandbox: "workspace-write",
        ephemeral: false,
        experimentalRawEvents: false,
        persistExtendedHistory: false
      });

      this.rpcClient = client;
      this.threadId = response.thread.id;
      return this.threadId;
    } catch {
      this.fallbackMode = true;
      return this.sessionId;
    }
  }

  public async sendMessage(request: AdapterSendRequest, callbacks: AdapterCallbacks): Promise<void> {
    await this.startSession();
    this.currentCallbacks = callbacks;
    this.currentText = "";
    this.stopped = false;

    if (this.fallbackMode || !this.rpcClient || !this.threadId) {
      await this.runFallbackExec(request, callbacks);
      return;
    }

    try {
      const response = await this.rpcClient.request<{ turn: { id: string } }>("turn/start", {
        threadId: this.threadId,
        input: [
          {
            type: "text",
            text: request.text,
            text_elements: []
          }
        ]
      });
      this.currentTurnId = response.turn.id;
    } catch (error) {
      callbacks.onError(error as Error, (error as Error).message);
    }
  }

  public async resolveApproval(requestId: string, decision: "approve" | "deny"): Promise<void> {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending || !this.rpcClient) {
      return;
    }

    let result: unknown;
    switch (pending.method) {
      case "item/commandExecution/requestApproval":
        result = { decision: decision === "approve" ? "accept" : "decline" };
        break;
      case "item/fileChange/requestApproval":
        result = { decision: decision === "approve" ? "accept" : "decline" };
        break;
      case "item/permissions/requestApproval":
        result =
          decision === "approve"
            ? { permissions: pending.params.permissions ?? {}, scope: "session" }
            : { permissions: {}, scope: "turn" };
        break;
      default:
        result = { decision: decision === "approve" ? "accept" : "decline" };
        break;
    }

    this.rpcClient.respond(requestId, result);
    this.pendingApprovals.delete(requestId);
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    if (this.currentTurnId && this.rpcClient && this.threadId) {
      try {
        await this.rpcClient.request("turn/interrupt", {
          threadId: this.threadId,
          turnId: this.currentTurnId
        });
      } catch {
        // Ignore and fall back to process kill if needed.
      }
    }
    await killProcessTree(this.fallbackChild);
    this.fallbackChild = undefined;
  }

  public async dispose(): Promise<void> {
    await this.stop();
    await this.rpcClient?.stop();
    this.rpcClient = undefined;
  }

  private async runFallbackExec(request: AdapterSendRequest, callbacks: AdapterCallbacks): Promise<void> {
    const config = this.configProvider();
    const outputFile = path.join(os.tmpdir(), `broker-codex-${createId()}.txt`);
    const args = ["exec", "--skip-git-repo-check", "-o", outputFile, request.text];

    const child = spawnCli(config.codexPath, args, {
      cwd: this.cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    this.fallbackChild = child;
    const stdout = child.stdout;
    const stderr = child.stderr;
    if (!stdout || !stderr) {
      callbacks.onError(new Error("Codex fallback process did not expose stdout/stderr pipes."));
      return;
    }
    stdout.setEncoding("utf8");
    stderr.setEncoding("utf8");

    const stderrChunks: string[] = [];
    stderr.on("data", (chunk: string) => stderrChunks.push(chunk));

    await new Promise<void>((resolve) => {
      child.once("close", async (code) => {
        this.fallbackChild = undefined;
        if (this.stopped) {
          resolve();
          return;
        }

        try {
          const text = await fs.readFile(outputFile, "utf8");
          if (text) {
            callbacks.onTextDelta(text);
            callbacks.onComplete();
          } else {
            callbacks.onError(new Error(`Codex exec exited with code ${code ?? "unknown"}.`), stderrChunks.join("").trim());
          }
        } catch (error) {
          callbacks.onError(error as Error, stderrChunks.join("").trim());
        } finally {
          fs.rm(outputFile, { force: true }).catch(() => undefined);
          resolve();
        }
      });

      child.once("error", (error) => {
        this.fallbackChild = undefined;
        callbacks.onError(error, error.message);
        resolve();
      });
    });
  }

  private handleNotification(method: string, params: unknown): void {
    if (!this.currentCallbacks) {
      return;
    }

    const payload = (params ?? {}) as Record<string, unknown>;
    if (method === "item/agentMessage/delta" && payload.turnId === this.currentTurnId && typeof payload.delta === "string") {
      this.currentText += payload.delta;
      this.currentCallbacks.onTextDelta(payload.delta);
      return;
    }

    if (method === "turn/completed" && payload.threadId === this.threadId) {
      const turn = payload.turn as Record<string, unknown> | undefined;
      const status = typeof turn?.status === "string" ? turn.status : undefined;
      this.currentTurnId = undefined;
      if (status === "failed") {
        const error = (turn?.error as Record<string, unknown> | undefined)?.message;
        this.currentCallbacks.onError(new Error(typeof error === "string" ? error : "Codex turn failed."));
      } else {
        this.currentCallbacks.onComplete();
      }
      return;
    }

    if (method === "error") {
      const message = typeof payload.message === "string" ? payload.message : "Codex app-server reported an error.";
      this.currentCallbacks.onSystemMessage?.(message);
    }
  }

  private handleServerRequest(id: string, method: string, params: unknown): void {
    if (!this.currentCallbacks) {
      return;
    }

    const payload = (params ?? {}) as Record<string, unknown>;
    const detail = JSON.stringify(payload, null, 2);
    const approval: ApprovalState = {
      agent: "codex",
      requestId: id,
      method,
      title: this.getApprovalTitle(method),
      detail,
      rawParams: payload,
      resolved: false
    };
    this.pendingApprovals.set(id, { requestId: id, method, params: payload });
    this.currentCallbacks.onApproval?.(approval);
  }

  private getApprovalTitle(method: string): string {
    switch (method) {
      case "item/commandExecution/requestApproval":
        return "Codex requests command approval";
      case "item/fileChange/requestApproval":
        return "Codex requests file change approval";
      case "item/permissions/requestApproval":
        return "Codex requests extra permissions";
      default:
        return `Codex requests approval: ${method}`;
    }
  }
}
