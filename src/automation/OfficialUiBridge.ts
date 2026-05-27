import { execFile } from "child_process";
import { promisify } from "util";
import * as vscode from "vscode";
import { AgentKind } from "../types";

const execFileAsync = promisify(execFile);

export class OfficialUiBridge {
  public async sendToAgent(target: AgentKind, text: string): Promise<string> {
    if (process.platform !== "win32") {
      throw new Error("The official UI bridge is currently implemented for Windows only.");
    }

    const previousClipboard = await this.readClipboardSafely();
    await vscode.env.clipboard.writeText(text);

    try {
      await this.focusTarget(target);
      await this.delay(this.getFocusDelay(target));
      await this.sendKeys(["^v", this.getSubmitKeys(target, text)]);
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

  private async delay(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
