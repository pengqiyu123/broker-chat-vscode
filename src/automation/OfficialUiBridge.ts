import { execFile } from "child_process";
import { promisify } from "util";
import * as vscode from "vscode";
import { AgentKind } from "../types";
import { BrokerLogger } from "./BrokerLogger";
import { identifyFocusedElement } from "./FocusDetector";
import { isForegroundWorkspaceWindow, WindowSnapshot } from "./windowFocusGuard";

const execFileAsync = promisify(execFile);

export class OfficialUiBridge {
  public constructor(
    private readonly workspaceCwd: string,
    private readonly logger?: BrokerLogger
  ) {}

  public async sendToAgent(
    target: AgentKind,
    text: string,
    context: { trigger?: "manual" | "auto-forward" } = {}
  ): Promise<string> {
    if (process.platform !== "win32") {
      throw new Error("The official UI bridge is currently implemented for Windows only.");
    }

    const trigger = context.trigger ?? "manual";
    this.logInfo(`bridge start trigger=${trigger} target=${target} chars=${text.length}`);

    // Safety: verify VS Code workspace window is the foreground window
    await this.assertForegroundWorkspaceWindow("before-bridge");

    const previousClipboard = await this.readClipboardSafely();
    await vscode.env.clipboard.writeText(text);
    this.logInfo(`clipboard prepared chars=${text.length}`);

    try {
      await this.logFocusProbe("before-focus", target, trigger);
      await this.focusTarget(target);
      await this.delay(this.getFocusDelay(target));
      await this.logFocusProbe("after-focus", target, trigger);
      await this.sendKeys(["^v", this.getSubmitKeys(target, text)]);
      this.logInfo(`bridge complete trigger=${trigger} target=${target}`);
    } catch (error) {
      this.logError(`bridge failed trigger=${trigger} target=${target}: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    } finally {
      void this.restoreClipboard(previousClipboard);
    }

    return target === "claude" ? "已桥接发送到 Claude 官方面板。" : "已桥接发送到 Codex 官方面板。";
  }

  private async focusTarget(target: AgentKind): Promise<void> {
    if (target === "claude") {
      await this.focusClaudeTarget();
      return;
    }

    await this.focusCodexTarget();
  }

  private getFocusDelay(target: AgentKind): number {
    return target === "claude" ? 180 : 320;
  }

  private getSubmitKeys(target: AgentKind, text: string): string {
    if (target === "claude") {
      const useCtrlEnter = vscode.workspace.getConfiguration("claudeCode").get<boolean>("useCtrlEnterToSend", false);
      return useCtrlEnter ? "^{ENTER}" : "{ENTER}";
    }

    const enterBehavior = vscode.workspace.getConfiguration("chatgpt").get<string>("composerEnterBehavior", "enter");
    const hasMultilineText = /\r?\n/.test(text);
    return enterBehavior === "cmdIfMultiline" && hasMultilineText ? "^{ENTER}" : "{ENTER}";
  }

  private async sendKeys(keys: string[]): Promise<void> {
    const lines = [
      "$wshell = New-Object -ComObject WScript.Shell",
      "Start-Sleep -Milliseconds 60",
      ...keys.flatMap((key) => [
        `$wshell.SendKeys('${this.escapePowerShellSingleQuoted(key)}')`,
        "Start-Sleep -Milliseconds 80"
      ])
    ];

    await execFileAsync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", lines.join("; ")],
      { windowsHide: true }
    );
  }

  private async restoreClipboard(previousClipboard: string): Promise<void> {
    await this.delay(250);
    await vscode.env.clipboard.writeText(previousClipboard);
  }

  private async readClipboardSafely(): Promise<string> {
    try {
      return await vscode.env.clipboard.readText();
    } catch {
      return "";
    }
  }

  private escapePowerShellSingleQuoted(value: string): string {
    return value.replace(/'/g, "''");
  }

  private async focusClaudeTarget(): Promise<void> {
    const useTerminal = vscode.workspace.getConfiguration("claudeCode").get<boolean>("useTerminal", false);
    if (useTerminal) {
      await this.tryCommands(["claude-vscode.terminal.open"]);
      return;
    }
    await this.tryCommands(["claude-vscode.focus"]);
  }

  private async focusCodexTarget(): Promise<void> {
    await this.tryCommands([
      "chatgpt.openSidebar",
      "workbench.view.extension.codexSecondaryViewContainer",
      "workbench.view.extension.codexViewContainer",
      "chatgpt.newCodexPanel"
    ]);

    await this.delay(120);

    await this.tryCommands([
      "workbench.action.focusAuxiliaryBar",
      "workbench.action.focusSideBar"
    ]);
  }

  private async tryCommands(commands: string[]): Promise<void> {
    let lastError: unknown;

    for (const command of commands) {
      try {
        await vscode.commands.executeCommand(command);
        return;
      } catch (error) {
        lastError = error;
      }
    }

    if (lastError instanceof Error) {
      throw lastError;
    }

    throw new Error(`Unable to execute any of the commands: ${commands.join(", ")}`);
  }

  private async assertForegroundWorkspaceWindow(stage: string): Promise<void> {
    const [windows, foregroundPid] = await Promise.all([this.listWindows(), this.getForegroundPid()]);
    const result = isForegroundWorkspaceWindow(windows, foregroundPid, this.workspaceCwd);
    if (!result.ok) {
      this.logError(`foreground check failed stage=${stage} foregroundPid=${foregroundPid ?? "unknown"} error=${result.error ?? ""}`);
      throw new Error(result.error || "当前前台窗口不是 Broker 所在 VS Code 工作区。");
    }
    this.logInfo(`foreground check ok stage=${stage} pid=${result.window?.pid} title="${result.window?.title ?? ""}"`);
  }

  private async logFocusProbe(stage: string, target: AgentKind, trigger: "manual" | "auto-forward"): Promise<void> {
    try {
      const focus = await identifyFocusedElement();
      this.logInfo(
        [
          `focus probe stage=${stage}`,
          `trigger=${trigger}`,
          `target=${target}`,
          `identified=${focus.identifiedAgent}`,
          `rule=${focus.rule}`,
          `current=${focus.currentSummary}`,
          `chain=${focus.chainSummary}`
        ].join(" | ")
      );
    } catch (error) {
      this.logError(
        `focus probe failed stage=${stage} trigger=${trigger} target=${target}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async listWindows(): Promise<WindowSnapshot[]> {
    const script = [
      "Get-Process |",
      "Where-Object { $_.MainWindowTitle } |",
      "Select-Object Id,ProcessName,MainWindowTitle |",
      "ConvertTo-Json -Compress"
    ].join(" ");
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, maxBuffer: 1024 * 1024 }
    );
    const trimmed = stdout.trim();
    if (!trimmed) {
      return [];
    }

    const parsed = JSON.parse(trimmed) as unknown;
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows
      .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
      .map((entry) => ({
        pid: Number(entry.Id),
        processName: String(entry.ProcessName ?? ""),
        title: String(entry.MainWindowTitle ?? "")
      }))
      .filter((entry) => Number.isFinite(entry.pid) && entry.title.trim());
  }

  private async getForegroundPid(): Promise<number | undefined> {
    const script = [
      "$signature = @'",
      "using System;",
      "using System.Runtime.InteropServices;",
      "public static class Win32BrokerForeground {",
      "  [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow();",
      "  [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);",
      "}",
      "'@",
      "Add-Type -TypeDefinition $signature -ErrorAction SilentlyContinue",
      "$hwnd = [Win32BrokerForeground]::GetForegroundWindow()",
      "$foregroundProcessId = [uint32]0",
      "[void][Win32BrokerForeground]::GetWindowThreadProcessId($hwnd, [ref]$foregroundProcessId)",
      "Write-Output $foregroundProcessId"
    ].join("\n");

    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true }
    );
    const pid = Number(stdout.trim());
    return Number.isFinite(pid) && pid > 0 ? pid : undefined;
  }

  private async delay(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private logInfo(message: string): void {
    this.logger?.info(message);
  }

  private logError(message: string): void {
    this.logger?.error(message);
  }
}
