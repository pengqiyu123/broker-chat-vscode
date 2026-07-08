import { execFile } from "child_process";
import { promisify } from "util";
import * as vscode from "vscode";
import { AgentKind, BridgeTrigger } from "../types";
import { BrokerLogger } from "./BrokerLogger";
import { identifyFocusedElement } from "./FocusDetector";
import { isForegroundWorkspaceWindow, selectUniqueWorkspaceWindow, WindowSnapshot } from "./windowFocusGuard";

const execFileAsync = promisify(execFile);

export class OfficialUiBridge {
  public constructor(
    private readonly workspaceCwd: string,
    private readonly logger?: BrokerLogger
  ) {}

  public async sendToAgent(
    target: AgentKind,
    text: string,
    context: { trigger?: BridgeTrigger } = {}
  ): Promise<string> {
    if (process.platform !== "win32") {
      throw new Error("The official UI bridge is currently implemented for Windows only.");
    }

    const trigger = context.trigger ?? "manual";
    this.logInfo(`bridge start trigger=${trigger} target=${target} chars=${text.length}`);

    // Safety: verify VS Code workspace window is foreground; agent commands may first
    // bring the already-identified workspace window forward, then re-run the guard.
    await this.assertForegroundWorkspaceWindow("before-bridge", { allowActivation: trigger === "agent-command" });

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

  private async assertForegroundWorkspaceWindow(
    stage: string,
    options: { allowActivation?: boolean } = {}
  ): Promise<void> {
    const [windows, foreground] = await Promise.all([this.listWindows(), this.getForegroundWindow()]);
    const result = isForegroundWorkspaceWindow(windows, foreground, this.workspaceCwd);
    if (!result.ok) {
      this.logError(
        [
          `foreground check failed stage=${stage}`,
          `foreground=${this.formatWindow(foreground)}`,
          `error=${result.error ?? ""}`
        ].join(" ")
      );
      if (options.allowActivation && await this.tryActivateWorkspaceWindow(windows, stage)) {
        return;
      }
      throw new Error(result.error || "当前前台窗口不是 Broker 所在 VS Code 工作区。");
    }
    this.logInfo(`foreground check ok stage=${stage} pid=${result.window?.pid} title="${result.window?.title ?? ""}"`);
  }

  private async tryActivateWorkspaceWindow(windows: WindowSnapshot[], stage: string): Promise<boolean> {
    const selected = selectUniqueWorkspaceWindow(windows, this.workspaceCwd);
    if (!selected.ok || !selected.window) {
      this.logError(`foreground activation skipped stage=${stage} error=${selected.error ?? ""}`);
      return false;
    }

    this.logInfo(
      `foreground activation attempt stage=${stage} ${this.formatWindow(selected.window)}`
    );

    try {
      const activationResult = await this.activateWorkspaceWindow(selected.window);
      this.logInfo(`foreground activation command result stage=${stage} ${activationResult}`);
    } catch (error) {
      this.logError(
        `foreground activation command failed stage=${stage}: ${error instanceof Error ? error.message : String(error)}`
      );
      return false;
    }

    await this.delay(450);

    const [afterWindows, afterForeground] = await Promise.all([this.listWindows(), this.getForegroundWindow()]);
    const after = isForegroundWorkspaceWindow(afterWindows, afterForeground, this.workspaceCwd);
    if (!after.ok) {
      this.logError(
        [
          `foreground activation failed stage=${stage}`,
          `foreground=${this.formatWindow(afterForeground)}`,
          `error=${after.error ?? ""}`
        ].join(" ")
      );
      return false;
    }

    this.logInfo(
      `foreground activation ok stage=${stage} ${this.formatWindow(after.window)}`
    );
    return true;
  }

  private async logFocusProbe(stage: string, target: AgentKind, trigger: BridgeTrigger): Promise<void> {
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
      "Select-Object Id,ProcessName,MainWindowTitle,@{Name='Hwnd';Expression={[int64]$_.MainWindowHandle}} |",
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
      .map((entry) => {
        const hwnd = Number(entry.Hwnd);
        return {
          pid: Number(entry.Id),
          processName: String(entry.ProcessName ?? ""),
          title: String(entry.MainWindowTitle ?? ""),
          hwnd: Number.isFinite(hwnd) && hwnd > 0 ? hwnd : undefined
        };
      })
      .filter((entry) => Number.isFinite(entry.pid) && entry.title.trim());
  }

  private async activateWorkspaceWindow(window: WindowSnapshot): Promise<string> {
    if (typeof window.hwnd === "number" && Number.isFinite(window.hwnd) && window.hwnd > 0) {
      return this.activateWindowByHwnd(window.hwnd);
    }

    return this.activateWindowByPid(window.pid);
  }

  private async activateWindowByPid(pid: number): Promise<string> {
    const script = [
      "$wshell = New-Object -ComObject WScript.Shell",
      `$ok = $wshell.AppActivate(${pid})`,
      `[pscustomobject]@{ method = 'AppActivate'; requestedPid = ${pid}; ok = [bool]$ok } | ConvertTo-Json -Compress`
    ].join("\n");

    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true }
    );
    return stdout.trim();
  }

  private async activateWindowByHwnd(hwnd: number): Promise<string> {
    const safeHwnd = Math.trunc(hwnd);
    const script = [
      "$signature = @'",
      "using System;",
      "using System.Runtime.InteropServices;",
      "public static class Win32BrokerWindowActivation {",
      "  [DllImport(\"user32.dll\")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);",
      "  [DllImport(\"user32.dll\")] public static extern bool IsIconic(IntPtr hWnd);",
      "  [DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr hWnd);",
      "  [DllImport(\"user32.dll\")] public static extern bool BringWindowToTop(IntPtr hWnd);",
      "  [DllImport(\"user32.dll\")] public static extern IntPtr SetActiveWindow(IntPtr hWnd);",
      "  [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow();",
      "  [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);",
      "  [DllImport(\"user32.dll\")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);",
      "  [DllImport(\"user32.dll\")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab);",
      "  [DllImport(\"kernel32.dll\")] public static extern uint GetCurrentThreadId();",
      "}",
      "'@",
      "Add-Type -TypeDefinition $signature -ErrorAction SilentlyContinue",
      `$targetHwnd = [IntPtr]::new([int64]${safeHwnd})`,
      "$foregroundBefore = [Win32BrokerWindowActivation]::GetForegroundWindow()",
      "$targetPid = [uint32]0",
      "$foregroundPid = [uint32]0",
      "$targetThread = [Win32BrokerWindowActivation]::GetWindowThreadProcessId($targetHwnd, [ref]$targetPid)",
      "$foregroundThread = [Win32BrokerWindowActivation]::GetWindowThreadProcessId($foregroundBefore, [ref]$foregroundPid)",
      "$currentThread = [Win32BrokerWindowActivation]::GetCurrentThreadId()",
      "$attachedForeground = $false",
      "$attachedTarget = $false",
      "try {",
      "  if ([Win32BrokerWindowActivation]::IsIconic($targetHwnd)) {",
      "    [void][Win32BrokerWindowActivation]::ShowWindowAsync($targetHwnd, 9)",
      "  } else {",
      "    [void][Win32BrokerWindowActivation]::ShowWindowAsync($targetHwnd, 5)",
      "  }",
      "  if ($foregroundThread -ne 0 -and $foregroundThread -ne $currentThread) {",
      "    $attachedForeground = [Win32BrokerWindowActivation]::AttachThreadInput($currentThread, $foregroundThread, $true)",
      "  }",
      "  if ($targetThread -ne 0 -and $targetThread -ne $currentThread) {",
      "    $attachedTarget = [Win32BrokerWindowActivation]::AttachThreadInput($currentThread, $targetThread, $true)",
      "  }",
      "  $bringWindowToTop = [Win32BrokerWindowActivation]::BringWindowToTop($targetHwnd)",
      "  $activeWindow = [Win32BrokerWindowActivation]::SetActiveWindow($targetHwnd)",
      "  $setForeground = [Win32BrokerWindowActivation]::SetForegroundWindow($targetHwnd)",
      "  [Win32BrokerWindowActivation]::SwitchToThisWindow($targetHwnd, $true)",
      "} finally {",
      "  if ($attachedTarget) { [void][Win32BrokerWindowActivation]::AttachThreadInput($currentThread, $targetThread, $false) }",
      "  if ($attachedForeground) { [void][Win32BrokerWindowActivation]::AttachThreadInput($currentThread, $foregroundThread, $false) }",
      "}",
      "Start-Sleep -Milliseconds 120",
      "$foregroundAfter = [Win32BrokerWindowActivation]::GetForegroundWindow()",
      "[pscustomobject]@{",
      "  method = 'SetForegroundWindow';",
      `  requestedHwnd = ${safeHwnd};`,
      "  targetPid = [int64]$targetPid;",
      "  foregroundBefore = $foregroundBefore.ToInt64();",
      "  foregroundAfter = $foregroundAfter.ToInt64();",
      "  foregroundMatches = ($foregroundAfter -eq $targetHwnd);",
      "  attachedForeground = [bool]$attachedForeground;",
      "  attachedTarget = [bool]$attachedTarget;",
      "  bringWindowToTop = [bool]$bringWindowToTop;",
      "  setForeground = [bool]$setForeground;",
      "  activeWindow = $activeWindow.ToInt64()",
      "} | ConvertTo-Json -Compress"
    ].join("\n");

    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true }
    );
    return stdout.trim();
  }

  private async getForegroundWindow(): Promise<WindowSnapshot | undefined> {
    const script = [
      "$signature = @'",
      "using System;",
      "using System.Runtime.InteropServices;",
      "using System.Text;",
      "public static class Win32BrokerForeground {",
      "  [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow();",
      "  [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);",
      "  [DllImport(\"user32.dll\", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);",
      "}",
      "'@",
      "Add-Type -TypeDefinition $signature -ErrorAction SilentlyContinue",
      "$hwnd = [Win32BrokerForeground]::GetForegroundWindow()",
      "$foregroundProcessId = [uint32]0",
      "[void][Win32BrokerForeground]::GetWindowThreadProcessId($hwnd, [ref]$foregroundProcessId)",
      "$titleBuilder = New-Object System.Text.StringBuilder 1024",
      "[void][Win32BrokerForeground]::GetWindowText($hwnd, $titleBuilder, $titleBuilder.Capacity)",
      "$process = Get-Process -Id $foregroundProcessId -ErrorAction SilentlyContinue",
      "$processName = if ($process) { $process.ProcessName } else { '' }",
      "[pscustomobject]@{",
      "  Id = $foregroundProcessId;",
      "  Hwnd = $hwnd.ToInt64();",
      "  ProcessName = $processName;",
      "  MainWindowTitle = $titleBuilder.ToString()",
      "} | ConvertTo-Json -Compress"
    ].join("\n");

    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true }
    );
    const trimmed = stdout.trim();
    if (!trimmed) {
      return undefined;
    }

    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const pid = Number(parsed.Id);
    if (!Number.isFinite(pid) || pid <= 0) {
      return undefined;
    }

    return {
      pid,
      processName: String(parsed.ProcessName ?? ""),
      title: String(parsed.MainWindowTitle ?? ""),
      hwnd: Number.isFinite(Number(parsed.Hwnd)) && Number(parsed.Hwnd) > 0 ? Number(parsed.Hwnd) : undefined
    };
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

  private formatWindow(window: WindowSnapshot | undefined): string {
    if (!window) {
      return "unknown";
    }

    const hwnd = typeof window.hwnd === "number" ? ` hwnd=${window.hwnd}` : "";
    return `${window.processName || "unknown"}#${window.pid}${hwnd} "${window.title}"`;
  }
}
