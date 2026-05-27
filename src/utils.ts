import * as crypto from "crypto";
import { ChildProcess, SpawnOptions, spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";

export function createId(): string {
  return crypto.randomUUID();
}

export function otherAgent(agent: "codex" | "claude"): "codex" | "claude" {
  return agent === "codex" ? "claude" : "codex";
}

export function killProcessTree(child: ChildProcess | undefined): Promise<void> {
  if (!child?.pid) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true
    });
    killer.on("close", () => resolve());
    killer.on("error", () => resolve());
  });
}

export function extractTextContent(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }

  const textParts = content
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return "";
      }
      const record = entry as Record<string, unknown>;
      return typeof record.text === "string" ? record.text : "";
    })
    .filter(Boolean);

  return textParts.join("");
}

export function resolveCliCommand(command: string): string {
  if (process.platform !== "win32") {
    return command;
  }

  const ext = path.extname(command).toLowerCase();
  if (ext === ".cmd" || ext === ".exe" || ext === ".bat" || ext === ".ps1") {
    return command;
  }

  const appData = process.env.APPDATA;
  if (appData) {
    const npmShim = path.join(appData, "npm", `${command}.cmd`);
    if (fs.existsSync(npmShim)) {
      return npmShim;
    }
  }

  return `${command}.cmd`;
}

export function spawnCli(command: string, args: string[], options: SpawnOptions = {}): ChildProcess {
  const resolved = resolveCliCommand(command);

  if (process.platform === "win32") {
    return spawn(resolved, args, {
      ...options,
      shell: true
    });
  }

  return spawn(resolved, args, options);
}

export function normalizePath(p: string | undefined): string {
  if (!p) {
    return "";
  }

  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}
