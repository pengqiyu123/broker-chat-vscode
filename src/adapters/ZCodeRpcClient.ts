import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { createId, killProcessTree } from "../utils";

// ZCode app-server 协议外壳：{ id, method, params }，严格禁止 jsonrpc 字段。
// 见 docs/send-method-test-log.md ZC-INFRA-004 / ZC-DUP-002。
type ZCodeRequest = {
  id: string;
  method: string;
  params?: unknown;
};

type ZCodeNotification = {
  method: string;
  params?: unknown;
};

type ZCodeResponse = {
  id: string;
  result?: unknown;
  error?: {
    code: number;
    message: string;
  };
};

export interface ZCodeListSession {
  sessionId: string;
  workspace?: {
    workspacePath?: string;
    workspaceKey?: string;
  };
  updatedAt?: number;
  createdAt?: number;
  title?: string;
  status?: string;
}

export interface ZCodeListResult {
  sessions?: ZCodeListSession[];
}

export interface ZCodeMessagePart {
  text?: string;
  type?: string;
}

export interface ZCodeReadMessage {
  info?: {
    role?: string;
    finish?: string;
    time?: {
      created?: number;
    };
  };
  // ZCode 消息正文在 parts[].text（type 区分 text/tool 等）
  parts?: ZCodeMessagePart[];
  // 兼容旧字段（某些版本可能用 content）
  content?: string;
}

export interface ZCodeReadResult {
  messages?: ZCodeReadMessage[];
}

export class ZCodeRpcClient {
  private process?: ChildProcessWithoutNullStreams;
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private notificationHandler?: (message: ZCodeNotification) => void;
  private running = false;

  public constructor(private readonly exePath: string, private readonly scriptPath: string) {}

  public get isRunning(): boolean {
    return this.running;
  }

  public async start(): Promise<void> {
    if (this.process) {
      return;
    }

    // 必须 ELECTRON_RUN_AS_NODE=1，否则 stdin 写入返回 Errno 22。
    // 见 docs/send-method-test-log.md。
    const child = spawn(this.exePath, [this.scriptPath, "app-server", "--stdio"], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
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

      let parsed: ZCodeResponse | ZCodeNotification;
      try {
        parsed = JSON.parse(line) as ZCodeResponse | ZCodeNotification;
      } catch {
        return;
      }

      if ("id" in parsed && ("result" in parsed || "error" in parsed)) {
        const resolver = this.pending.get((parsed as ZCodeResponse).id);
        if (!resolver) {
          return;
        }
        this.pending.delete((parsed as ZCodeResponse).id);
        const response = parsed as ZCodeResponse;
        if (response.error) {
          resolver.reject(new Error(response.error.message));
        } else {
          resolver.resolve(response.result);
        }
        return;
      }

      if ("method" in parsed) {
        this.notificationHandler?.(parsed as ZCodeNotification);
      }
    });

    child.once("error", (error) => {
      this.running = false;
      for (const entry of this.pending.values()) {
        entry.reject(error);
      }
      this.pending.clear();
    });

    child.once("close", () => {
      this.running = false;
      for (const entry of this.pending.values()) {
        entry.reject(new Error("ZCode app-server process closed."));
      }
      this.pending.clear();
    });

    this.process = child;
    this.running = true;
  }

  public onNotification(handler: (message: ZCodeNotification) => void): void {
    this.notificationHandler = handler;
  }

  public async request<T>(method: string, params?: unknown): Promise<T> {
    if (!this.process) {
      throw new Error("ZCode app-server is not running.");
    }

    const id = createId();
    // 注意：不带 jsonrpc 字段。
    const payload: ZCodeRequest = {
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

  public async stop(): Promise<void> {
    this.running = false;
    await killProcessTree(this.process);
    this.process = undefined;
    this.pending.clear();
  }
}

// 从 ZCode 桌面 config.json 构造 runtimeModel（脱敏：apiKey 只在内存传给 app-server，绝不落盘/进日志）。
// config.json 结构：provider.<providerId>.{ name, kind, options:{apiKey,baseURL}, enabled, models:{<modelId>:...} }
// runtimeModel schema 见 docs/send-method-test-log.md ZC-DUP-006。
export interface ZCodeRuntimeModel {
  revision: string;
  generatedAt: number;
  model: {
    providerId: string;
    modelId: string;
  };
  provider: {
    providerId: string;
    kind: string;
    models: Array<{ modelId: string }>;
  };
}

interface ZCodeProviderConfig {
  name?: string;
  kind?: string;
  enabled?: boolean;
  options?: {
    apiKey?: string;
    baseURL?: string;
  };
  models?: Record<string, unknown>;
}

interface ZCodeConfigFile {
  provider?: Record<string, ZCodeProviderConfig>;
  model?: string;
}

export function buildRuntimeModel(dataDir: string): ZCodeRuntimeModel {
  // 数据目录约定：<dataDir>\.zcode\v2\config.json
  const configPath = path.join(dataDir, ".zcode", "v2", "config.json");
  const raw = fs.readFileSync(configPath, "utf8");
  const config = JSON.parse(raw) as ZCodeConfigFile;
  const providers = config.provider ?? {};

  // 必须用 enabled=true 的 provider，否则触发 ZCODE_RUNTIME_MODEL_UNAVAILABLE。
  let providerId = "";
  let provider: ZCodeProviderConfig | undefined;
  for (const id of Object.keys(providers)) {
    const candidate = providers[id];
    if (candidate && candidate.enabled === true) {
      providerId = id;
      provider = candidate;
      break;
    }
  }

  if (!provider) {
    throw new Error("No enabled ZCode provider found in config.json");
  }

  const modelIds = provider.models ? Object.keys(provider.models) : [];
  if (modelIds.length === 0) {
    throw new Error("Enabled ZCode provider has no models");
  }

  const modelId = modelIds[0];

  return {
    revision: "1",
    generatedAt: Date.now(),
    model: {
      providerId,
      modelId
    },
    provider: {
      providerId,
      kind: provider.kind ?? "anthropic",
      models: modelIds.map((m) => ({ modelId: m }))
    }
  };
}
