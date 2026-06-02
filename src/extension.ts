import * as vscode from "vscode";
import { BrokerLogger } from "./automation/BrokerLogger";
import { BrokerController } from "./controller/brokerController";
import { BrokerPanel } from "./ui/BrokerPanel";
import { BrokerSidebarViewProvider } from "./ui/BrokerSidebarViewProvider";

let controller: BrokerController | undefined;
let logger: BrokerLogger | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  logger = new BrokerLogger();
  controller = new BrokerController(cwd, logger);
  context.subscriptions.push(logger, controller);

  const sidebarProvider = new BrokerSidebarViewProvider(context, controller);
  context.subscriptions.push(
    sidebarProvider,
    vscode.window.registerWebviewViewProvider(BrokerSidebarViewProvider.viewType, sidebarProvider, {
      webviewOptions: {
        retainContextWhenHidden: true
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("broker.openChat", async () => {
      if (!controller) {
        return;
      }
      await controller.refreshMonitor();
      const revealedSidebar = await sidebarProvider.reveal();
      if (revealedSidebar) {
        sidebarProvider.postSnapshot();
        return;
      }

      BrokerPanel.createOrShow(context, controller).postSnapshot();
    }),
    vscode.commands.registerCommand("broker.newSession", async () => {
      if (!controller) {
        return;
      }
      await controller.newSession();
      if (sidebarProvider.isReady()) {
        sidebarProvider.postSnapshot();
      } else {
        BrokerPanel.createOrShow(context, controller).postSnapshot();
      }
    }),
    vscode.commands.registerCommand("broker.stopActiveResponse", async () => {
      await controller?.stop();
    }),
    vscode.commands.registerCommand("broker.showLogs", () => {
      logger?.toggle();
    })
  );
}

export function deactivate(): Promise<void> | undefined {
  return controller?.stop();
}
