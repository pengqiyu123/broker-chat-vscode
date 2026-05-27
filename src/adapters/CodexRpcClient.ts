import { ChildProcessWithoutNullStreams } from "child_process";
import * as readline from "readline";
import { BrokerConfig } from "../types";
import { createId, killProcessTree, spawnCli } from "../utils";

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: string;
  method: string;
  params?: unknown;
};

type JsonRpcNotification = {
  jsonrpc?: "2.0";
  method: string;
  params?: unknown;
};

type JsonRpcResponse = {
  jsonrpc?: "2.0";
  id: string;
  result?: unknown;
  error?: {
    code: number;
    message: string;
  };
};

export class CodexRpcClient {
  private process?: ChildProcessWithoutNullStreams;
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private notificationHandler?: (message: JsonRpcNotification) => void;
  private requestHandler?: (message: JsonRpcRequest) => void;

  public constructor(private readonly configProvider: () => BrokerConfig, private readonly cwd: string) {}

  public async start(): Promise<void> {
    if (this.process) {
      return;
    }

    const config = this.configProvider();
    const child = spawnCli(config.codexPath, ["app-server"], {
      cwd: this.cwd,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    }) as ChildProcessWithoutNullStreams;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (rawLine) => {
      const line = rawLine.trim();
      if (!line) {
        return;
      }

      let parsed: JsonRpcResponse | JsonRpcNotification | JsonRpcRequest;
      try {
        parsed = JSON.parse(line) as JsonRpcResponse | JsonRpcNotification | JsonRpcRequest;
      } catch {
        return;
      }

      if ("id" in parsed && ("result" in parsed || "error" in parsed)) {
        const resolver = this.pending.get(parsed.id);
        if (!resolver) {
          return;
        }
        this.pending.delete(parsed.id);
        if (parsed.error) {
          resolver.reject(new Error(parsed.error.message));
        } else {
          resolver.resolve(parsed.result);
        }
        return;
      }

      if ("id" in parsed && "method" in parsed) {
        this.requestHandler?.(parsed);
        return;
      }

      if ("method" in parsed) {
        this.notificationHandler?.(parsed);
      }
    });

    child.once("error", (error) => {
      for (const entry of this.pending.values()) {
        entry.reject(error);
      }
      this.pending.clear();
    });

    this.process = child;
  }

  public onNotification(handler: (message: JsonRpcNotification) => void): void {
    this.notificationHandler = handler;
  }

  public onRequest(handler: (message: JsonRpcRequest) => void): void {
    this.requestHandler = handler;
  }

  public async request<T>(method: string, params?: unknown): Promise<T> {
    if (!this.process) {
      throw new Error("Codex app-server is not running.");
    }

    const id = createId();
    const payload: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params
    };

    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject
      });
      this.process?.stdin.write(`${JSON.stringify(payload)}\n`, "utf8");
    });
  }

  public notify(method: string, params?: unknown): void {
    if (!this.process) {
      return;
    }

    const payload = {
      jsonrpc: "2.0",
      method,
      params
    };

    this.process.stdin.write(`${JSON.stringify(payload)}\n`, "utf8");
  }

  public respond(id: string, result: unknown): void {
    if (!this.process) {
      return;
    }

    const payload = {
      jsonrpc: "2.0",
      id,
      result
    };

    this.process.stdin.write(`${JSON.stringify(payload)}\n`, "utf8");
  }

  public async stop(): Promise<void> {
    await killProcessTree(this.process);
    this.process = undefined;
  }
}
