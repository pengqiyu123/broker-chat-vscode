import * as vscode from "vscode";
import { BrokerController } from "../controller/brokerController";
import { BrokerWebviewConnection } from "./BrokerWebview";

export class BrokerSidebarViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewType = "brokerChatSidebar";

  private currentView: vscode.WebviewView | undefined;
  private currentConnection: BrokerWebviewConnection | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly viewDisposables: vscode.Disposable[] = [];

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly controller: BrokerController
  ) {}

  public resolveWebviewView(view: vscode.WebviewView): void {
    this.disposeCurrentView();
    this.currentView = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")]
    };

    this.currentConnection = new BrokerWebviewConnection(this.context, view.webview, this.controller);
    this.currentConnection.postSnapshot();

    this.viewDisposables.push(
      this.currentConnection,
      view.onDidChangeVisibility(() => {
        if (view.visible) {
          this.currentConnection?.postSnapshot();
        }
      })
    );
  }

  public async reveal(): Promise<boolean> {
    try {
      await vscode.commands.executeCommand(`${BrokerSidebarViewProvider.viewType}.focus`);
    } catch {
      return false;
    }

    await this.delay(80);
    this.currentConnection?.postSnapshot();
    return this.isReady();
  }

  public isReady(): boolean {
    return Boolean(this.currentView && this.currentConnection);
  }

  public postSnapshot(): void {
    this.currentConnection?.postSnapshot();
  }

  public dispose(): void {
    this.disposeCurrentView();
    while (this.disposables.length > 0) {
      this.disposables.pop()?.dispose();
    }
  }

  private disposeCurrentView(): void {
    this.currentConnection = undefined;
    this.currentView = undefined;
    while (this.viewDisposables.length > 0) {
      this.viewDisposables.pop()?.dispose();
    }
  }

  private async delay(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
