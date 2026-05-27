import * as vscode from "vscode";
import { BrokerController } from "../controller/brokerController";
import { BrokerWebviewConnection } from "./BrokerWebview";

export class BrokerPanel implements vscode.Disposable {
  private static currentPanel: BrokerPanel | undefined;

  public static createOrShow(context: vscode.ExtensionContext, controller: BrokerController): BrokerPanel {
    if (BrokerPanel.currentPanel) {
      BrokerPanel.currentPanel.panel.reveal(vscode.ViewColumn.Beside);
      BrokerPanel.currentPanel.postSnapshot();
      return BrokerPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel("brokerChat", "Broker Chat", vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")]
    });

    BrokerPanel.currentPanel = new BrokerPanel(context, panel, controller);
    return BrokerPanel.currentPanel;
  }

  private readonly disposables: vscode.Disposable[] = [];
  private readonly connection: BrokerWebviewConnection;

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly panel: vscode.WebviewPanel,
    private readonly controller: BrokerController
  ) {
    this.connection = new BrokerWebviewConnection(this.context, this.panel.webview, this.controller);
    this.disposables.push(
      this.connection,
      this.panel.onDidDispose(() => this.dispose())
    );
  }

  public dispose(): void {
    BrokerPanel.currentPanel = undefined;
    while (this.disposables.length > 0) {
      this.disposables.pop()?.dispose();
    }
  }

  public postSnapshot(): void {
    this.connection.postSnapshot();
  }
}
