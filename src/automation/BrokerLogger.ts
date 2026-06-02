import * as vscode from "vscode";

export class BrokerLogger implements vscode.Disposable {
  private readonly output = vscode.window.createOutputChannel("Broker Chat");
  private panelVisible = false;

  public info(message: string): void {
    this.append("info", message);
  }

  public error(message: string): void {
    this.append("error", message);
  }

  public toggle(): void {
    if (this.panelVisible) {
      this.output.hide();
      this.panelVisible = false;
    } else {
      this.output.show(true);
      this.panelVisible = true;
    }
  }

  public show(): void {
    this.output.show(true);
    this.panelVisible = true;
  }

  public dispose(): void {
    this.output.dispose();
  }

  private append(level: "info" | "error", message: string): void {
    const timestamp = new Date().toISOString();
    this.output.appendLine(`[${timestamp}] [${level}] ${message}`);
  }
}
