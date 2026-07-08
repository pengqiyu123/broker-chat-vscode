import * as crypto from "crypto";
import * as path from "path";

export interface BrokerRuntimeInfo {
  version: 1;
  workspaceCwd: string;
  workspaceFingerprint: string;
  port: number;
  token: string;
  pid: number;
  updatedAt: number;
}

const RUNTIME_DIR_NAME = ".broker-chat";
const RUNTIME_FILE_NAME = "runtime.json";

export function getBrokerRuntimeDir(workspaceCwd: string): string {
  return path.join(workspaceCwd, RUNTIME_DIR_NAME);
}

export function getBrokerRuntimeFilePath(workspaceCwd: string): string {
  return path.join(getBrokerRuntimeDir(workspaceCwd), RUNTIME_FILE_NAME);
}

export function fingerprintWorkspace(workspaceCwd: string): string {
  return crypto.createHash("sha256").update(normalizeWorkspacePath(workspaceCwd)).digest("hex").slice(0, 16);
}

export function normalizeWorkspacePath(workspaceCwd: string): string {
  return path.resolve(workspaceCwd).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}
