import * as crypto from "crypto";
import * as http from "http";
import type * as vscode from "vscode";
import type { MonitoredBridgeMode } from "../controller/bridgePrompt";
import type { BrokerController } from "../controller/brokerController";
import type { AgentKind } from "../types";

interface ApiEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

interface BrokerHttpServerStatus {
  host: "127.0.0.1";
  port: number;
  running: boolean;
  startedAt?: number;
  error?: string;
}

interface SendRequest {
  target: AgentKind;
  text: string;
  workspaceCwd: string;
}

interface ForwardLatestRequest {
  sourceAgent: AgentKind;
  mode: MonitoredBridgeMode;
  workspaceCwd: string;
  extraText: string;
  afterMessageId?: string;
  waitMs: number;
}

class HttpRequestError extends Error {
  public constructor(public readonly statusCode: number, message: string) {
    super(message);
  }
}

const MAX_BODY_BYTES = 256 * 1024;

export class BrokerHttpServer implements vscode.Disposable {
  private server: http.Server | undefined;
  private startedAt: number | undefined;
  private startError: string | undefined;

  public constructor(
    private readonly controller: BrokerController,
    private readonly port: number,
    private readonly token: string
  ) {}

  public async start(): Promise<void> {
    if (this.server?.listening) {
      return;
    }

    this.server = http.createServer((request, response) => {
      void this.handleRequest(request, response);
    });

    await new Promise<void>((resolve, reject) => {
      const server = this.server;
      if (!server) {
        reject(new Error("Broker HTTP server was not created."));
        return;
      }

      const onError = (error: Error): void => {
        this.startError = error.message;
        server.off("listening", onListening);
        reject(error);
      };

      const onListening = (): void => {
        this.startedAt = Date.now();
        this.startError = undefined;
        server.off("error", onError);
        resolve();
      };

      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.port, "127.0.0.1");
    });
  }

  public getStatus(): BrokerHttpServerStatus {
    return {
      host: "127.0.0.1",
      port: this.port,
      running: Boolean(this.server?.listening),
      startedAt: this.startedAt,
      error: this.startError
    };
  }

  public dispose(): void {
    this.server?.close();
    this.server = undefined;
  }

  private async handleRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");

    try {
      if (request.method !== "POST") {
        this.sendJson(response, 405, { ok: false, error: "Only POST requests are supported." });
        return;
      }

      if (!this.isAuthorized(request.headers.authorization)) {
        this.sendJson(response, 401, { ok: false, error: "Missing or invalid authorization token." });
        return;
      }

      const route = this.getRoute(request.url);
      if (route === "/api/status") {
        this.sendJson(response, 200, {
          ok: true,
          data: {
            ...this.controller.getSnapshot(),
            server: this.getStatus()
          }
        });
        return;
      }

      if (route === "/api/send") {
        const body = await this.readJsonBody(request);
        const sendRequest = this.parseSendRequest(body);
        try {
          const message = await this.controller.sendToAgentViaBridge(
            sendRequest.target,
            sendRequest.text,
            sendRequest.workspaceCwd
          );
          this.sendJson(response, 200, {
            ok: true,
            data: {
              message,
              snapshot: this.controller.getSnapshot()
            }
          });
        } catch (error) {
          this.sendJson(response, 409, { ok: false, error: this.toErrorMessage(error) });
        }
        return;
      }

      if (route === "/api/forward-latest") {
        const body = await this.readJsonBody(request);
        const forwardRequest = this.parseForwardLatestRequest(body);
        try {
          const result = await this.controller.forwardLatestMonitoredReply(
            forwardRequest.sourceAgent,
            forwardRequest.mode,
            forwardRequest.workspaceCwd,
            forwardRequest.extraText,
            forwardRequest.afterMessageId,
            forwardRequest.waitMs
          );

          if (!result.ok) {
            this.sendJson(response, 409, { ok: false, error: result.error || "Broker forward failed." });
            return;
          }

          this.sendJson(response, 200, {
            ok: true,
            data: {
              message: result.message,
              source: result.source,
              target: result.target,
              mode: result.mode,
              sessionId: result.sessionId,
              messageId: result.messageId,
              snapshot: this.controller.getSnapshot()
            }
          });
        } catch (error) {
          this.sendJson(response, 409, { ok: false, error: this.toErrorMessage(error) });
        }
        return;
      }

      this.sendJson(response, 404, { ok: false, error: "Unknown Broker API endpoint." });
    } catch (error) {
      const statusCode = error instanceof HttpRequestError ? error.statusCode : 500;
      this.sendJson(response, statusCode, { ok: false, error: this.toErrorMessage(error) });
    }
  }

  private getRoute(rawUrl: string | undefined): string {
    try {
      return new URL(rawUrl ?? "/", "http://127.0.0.1").pathname;
    } catch {
      throw new HttpRequestError(400, "Invalid request URL.");
    }
  }

  private isAuthorized(authorizationHeader: string | string[] | undefined): boolean {
    const authorization = Array.isArray(authorizationHeader) ? authorizationHeader[0] : authorizationHeader;
    if (!authorization || !this.token) {
      return false;
    }

    const expected = `Bearer ${this.token}`;
    const actualBuffer = Buffer.from(authorization, "utf8");
    const expectedBuffer = Buffer.from(expected, "utf8");
    if (actualBuffer.length !== expectedBuffer.length) {
      return false;
    }

    return crypto.timingSafeEqual(actualBuffer, expectedBuffer);
  }

  private async readJsonBody(request: http.IncomingMessage): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      let settled = false;

      const fail = (error: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        reject(error);
      };

      request.on("data", (chunk: Buffer) => {
        if (settled) {
          return;
        }
        totalBytes += chunk.length;
        if (totalBytes > MAX_BODY_BYTES) {
          fail(new HttpRequestError(413, "Request body is too large."));
          return;
        }
        chunks.push(Buffer.from(chunk));
      });

      request.on("end", () => {
        if (settled) {
          return;
        }
        settled = true;
        const raw = Buffer.concat(chunks).toString("utf8").trim();
        if (!raw) {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(raw) as unknown);
        } catch {
          reject(new HttpRequestError(400, "Invalid JSON body."));
        }
      });

      request.on("error", fail);
    });
  }

  private parseSendRequest(body: unknown): SendRequest {
    if (!this.isObject(body)) {
      throw new HttpRequestError(400, "Request body must be a JSON object.");
    }

    const target = body.target;
    if (target !== "codex" && target !== "claude") {
      throw new HttpRequestError(400, "target must be either \"codex\" or \"claude\".");
    }

    const text = body.text;
    if (typeof text !== "string" || !text.trim()) {
      throw new HttpRequestError(400, "text must be a non-empty string.");
    }

    const workspaceCwd = body.workspaceCwd;
    if (typeof workspaceCwd !== "string" || !workspaceCwd.trim()) {
      throw new HttpRequestError(400, "workspaceCwd must be a non-empty string.");
    }

    return {
      target,
      text,
      workspaceCwd
    };
  }

  private parseForwardLatestRequest(body: unknown): ForwardLatestRequest {
    if (!this.isObject(body)) {
      throw new HttpRequestError(400, "Request body must be a JSON object.");
    }

    const sourceAgent = body.sourceAgent;
    if (sourceAgent !== "codex" && sourceAgent !== "claude") {
      throw new HttpRequestError(400, "sourceAgent must be either \"codex\" or \"claude\".");
    }

    const mode = body.mode ?? "forward-answer";
    if (mode !== "forward-answer" && mode !== "merge-forward") {
      throw new HttpRequestError(400, "mode must be either \"forward-answer\" or \"merge-forward\".");
    }

    const workspaceCwd = body.workspaceCwd;
    if (typeof workspaceCwd !== "string" || !workspaceCwd.trim()) {
      throw new HttpRequestError(400, "workspaceCwd must be a non-empty string.");
    }

    const extraText = body.extraText;
    if (extraText !== undefined && typeof extraText !== "string") {
      throw new HttpRequestError(400, "extraText must be a string when provided.");
    }

    const afterMessageId = body.afterMessageId;
    if (afterMessageId !== undefined && (typeof afterMessageId !== "string" || !afterMessageId.trim())) {
      throw new HttpRequestError(400, "afterMessageId must be a non-empty string when provided.");
    }

    const waitMs = body.waitMs ?? 5000;
    if (typeof waitMs !== "number" || !Number.isInteger(waitMs) || waitMs < 0 || waitMs > 30_000) {
      throw new HttpRequestError(400, "waitMs must be an integer between 0 and 30000.");
    }

    return {
      sourceAgent,
      mode,
      workspaceCwd,
      extraText: extraText ?? "",
      afterMessageId,
      waitMs
    };
  }

  private sendJson<T>(response: http.ServerResponse, statusCode: number, body: ApiEnvelope<T>): void {
    if (response.headersSent || response.destroyed) {
      return;
    }

    response.statusCode = statusCode;
    response.end(JSON.stringify(body));
  }

  private isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
  }

  private toErrorMessage(error: unknown): string {
    if (error instanceof Error && error.message) {
      return error.message;
    }
    return String(error);
  }
}
