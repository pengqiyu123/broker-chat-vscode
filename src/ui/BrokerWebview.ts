import * as vscode from "vscode";
import { BrokerController } from "../controller/brokerController";
import { WebviewInboundMessage, WebviewOutboundMessage } from "../types";

export class BrokerWebviewConnection implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly webview: vscode.Webview,
    private readonly controller: BrokerController
  ) {
    this.webview.html = this.getHtml();
    this.disposables.push(
      this.webview.onDidReceiveMessage((message: WebviewInboundMessage) => void this.handleMessage(message)),
      this.controller.onDidChange((snapshot) => this.postMessage({ type: "snapshot", snapshot }))
    );
  }

  public dispose(): void {
    while (this.disposables.length > 0) {
      this.disposables.pop()?.dispose();
    }
  }

  public postSnapshot(): void {
    this.postMessage({ type: "snapshot", snapshot: this.controller.getSnapshot() });
  }

  private async handleMessage(message: WebviewInboundMessage): Promise<void> {
    switch (message.type) {
      case "ready":
        this.postSnapshot();
        return;
      case "refresh-monitor":
        await this.controller.refreshMonitor();
        return;
      case "bridge-send":
        if (
          (message.sourceAgent === "codex" || message.sourceAgent === "claude") &&
          typeof message.sessionId === "string" &&
          typeof message.messageId === "string" &&
          (message.mode === "merge-forward" || message.mode === "forward-answer")
        ) {
          await this.controller.bridgeMonitoredMessage(
            message.sourceAgent,
            message.sessionId,
            message.messageId,
            message.mode,
            typeof message.extraText === "string" ? message.extraText : ""
          );
        }
        return;
      case "show-logs":
        await vscode.commands.executeCommand("broker.showLogs");
        return;
      case "toggle-auto-forward":
        if (typeof message.autoForwardEnabled === "boolean") {
          await this.controller.setAutoForwardEnabled(message.autoForwardEnabled);
        }
        return;
      case "save-auto-forward-keywords":
        await this.controller.setAutoForwardKeywords(message.autoForwardKeywords);
        return;
      default:
        return;
    }
  }

  private postMessage(message: WebviewOutboundMessage): void {
    void this.webview.postMessage(message);
  }

  private getHtml(): string {
    const scriptUri = this.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "main.js"));
    const styleUri = this.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "styles.css"));
    const nonce = String(Date.now());

    return `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${this.webview.cspSource} data:; style-src ${this.webview.cspSource}; script-src 'nonce-${nonce}';" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${styleUri}" />
    <title>Broker Chat</title>
  </head>
  <body>
    <div class="app">
      <header class="topbar">
        <div class="topbar-row">
          <div class="brand">
            <div class="brand-title">Broker Chat</div>
            <div class="brand-subtitle">官方会话监控与桥接</div>
          </div>
          <div class="toolbar">
            <button id="settingsButton" class="icon-button" title="设置" aria-expanded="false">⚙</button>
            <button id="logsButton" class="ghost">日志</button>
            <button id="refreshButton" class="ghost">Refresh</button>
          </div>
        </div>
        <div id="statusBar" class="status-bar"></div>
        <div id="statusDetail" class="status-detail"></div>
        <div id="settingsPanel" class="settings-panel" hidden>
          <label class="toggle-row">
            <span>自动转发</span>
            <input id="autoForwardToggle" type="checkbox" />
          </label>
          <div class="keyword-grid">
            <label class="keyword-field">
              <span>发给 Codex</span>
              <textarea id="codexKeywords" class="keyword-input" rows="6"></textarea>
            </label>
            <label class="keyword-field">
              <span>发给 Claude</span>
              <textarea id="claudeKeywords" class="keyword-input" rows="6"></textarea>
            </label>
          </div>
          <div class="settings-actions">
            <button id="saveKeywordsButton" class="action-button">保存关键词</button>
            <button id="resetKeywordsButton" class="action-button secondary">恢复默认</button>
          </div>
        </div>
      </header>
      <main class="monitor-layout">
        <details class="verify-panel">
          <summary class="verify-summary">
            <div>
              <div class="section-title">连接验证</div>
              <div class="section-note">折叠前先快速确认两边会话和最近几条消息是否都已成功读取。</div>
            </div>
            <span class="verify-chevron">▸</span>
          </summary>
          <div class="verify-body">
            <section class="session-strip">
              <article class="session-panel">
                <div class="column-title codex">Codex Session</div>
                <div id="codexSession" class="session-card"></div>
              </article>
              <article class="session-panel">
                <div class="column-title claude">Claude Session</div>
                <div id="claudeSession" class="session-card"></div>
              </article>
            </section>
            <section class="preview-grid">
              <section>
                <div class="column-title codex">Latest Codex</div>
                <div id="codexPreview" class="messages preview-messages"></div>
              </section>
              <section>
                <div class="column-title claude">Latest Claude</div>
                <div id="claudePreview" class="messages preview-messages"></div>
              </section>
            </section>
          </div>
        </details>
        <section class="timeline-panel">
          <div class="section-header">
            <div>
              <div class="section-title">合并时间线</div>
              <div class="section-note">下面按消息出现时间混排，方便继续看真实顺序。</div>
            </div>
          </div>
          <div id="mergedTimeline" class="messages merged-messages"></div>
        </section>
      </main>
    </div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
  }
}
