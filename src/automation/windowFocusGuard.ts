import * as path from "path";

export interface WindowSnapshot {
  pid: number;
  processName: string;
  title: string;
}

export interface WindowSelectionResult {
  ok: boolean;
  window?: WindowSnapshot;
  error?: string;
}

const VSCODE_PROCESS_NAMES = new Set(["code", "code - insiders", "vscodium"]);
export type ForegroundWindowIdentity = number | WindowSnapshot | undefined;

export function selectUniqueWorkspaceWindow(
  windows: WindowSnapshot[],
  workspaceCwd: string
): WindowSelectionResult {
  const workspaceName = getWorkspaceName(workspaceCwd);
  if (!workspaceName) {
    return { ok: false, error: "无法识别当前 VS Code 工作区名称。" };
  }

  const matches = windows.filter((window) => isVsCodeWindow(window) && titleMatchesWorkspace(window.title, workspaceName));
  if (matches.length === 1) {
    return { ok: true, window: matches[0] };
  }

  if (matches.length === 0) {
    return { ok: false, error: `未找到当前工作区的 VS Code 窗口：${workspaceName}` };
  }

  return { ok: false, error: `找到多个当前工作区 VS Code 窗口：${workspaceName}` };
}

export function isForegroundWorkspaceWindow(
  windows: WindowSnapshot[],
  foreground: ForegroundWindowIdentity,
  workspaceCwd: string
): WindowSelectionResult {
  const foregroundPid = getForegroundPid(foreground);
  if (!foregroundPid) {
    return { ok: false, error: "无法识别当前前台窗口。" };
  }

  const selected = selectUniqueWorkspaceWindow(windows, workspaceCwd);
  if (!selected.ok || !selected.window) {
    return selected;
  }

  if (selected.window.pid === foregroundPid) {
    return selected;
  }

  if (isWindowSnapshot(foreground) && sameWorkspaceVsCodeWindow(foreground, workspaceCwd)) {
    return { ok: true, window: foreground };
  }

  return {
    ok: false,
    error: `当前前台窗口不是 ${getWorkspaceName(workspaceCwd)} 的 VS Code 窗口。`
  };
}

function isVsCodeWindow(window: WindowSnapshot): boolean {
  const processName = window.processName.trim().toLowerCase();
  if (VSCODE_PROCESS_NAMES.has(processName)) {
    return true;
  }

  return processName.includes("code") && window.title.toLowerCase().includes("visual studio code");
}

function titleMatchesWorkspace(title: string, workspaceName: string): boolean {
  return title.toLowerCase().includes(workspaceName.toLowerCase());
}

function getWorkspaceName(workspaceCwd: string): string {
  const normalized = workspaceCwd.replace(/[\\/]+$/, "");
  return path.basename(normalized);
}

function sameWorkspaceVsCodeWindow(window: WindowSnapshot, workspaceCwd: string): boolean {
  const workspaceName = getWorkspaceName(workspaceCwd);
  return Boolean(workspaceName) && isVsCodeWindow(window) && titleMatchesWorkspace(window.title, workspaceName);
}

function getForegroundPid(foreground: ForegroundWindowIdentity): number | undefined {
  if (typeof foreground === "number") {
    return foreground;
  }

  if (isWindowSnapshot(foreground)) {
    return foreground.pid;
  }

  return undefined;
}

function isWindowSnapshot(value: unknown): value is WindowSnapshot {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    typeof record.pid === "number" &&
    typeof record.processName === "string" &&
    typeof record.title === "string" &&
    Number.isFinite(record.pid)
  );
}
