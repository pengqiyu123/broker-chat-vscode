import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { BrokerController } from "./controller/brokerController";
import { BrokerHttpServer } from "./server/BrokerHttpServer";
import { BrokerPanel } from "./ui/BrokerPanel";
import { BrokerSidebarViewProvider } from "./ui/BrokerSidebarViewProvider";

let controller: BrokerController | undefined;
let httpServer: BrokerHttpServer | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  controller = new BrokerController(cwd);
  context.subscriptions.push(controller);

  const mcpPort = getMcpPort();
  const mcpToken = getOrCreateMcpToken();
  httpServer = new BrokerHttpServer(controller, mcpPort, mcpToken);
  try {
    await httpServer.start();
    context.subscriptions.push(httpServer);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    httpServer.dispose();
    httpServer = undefined;
    void vscode.window.showWarningMessage(`Broker MCP server could not start on 127.0.0.1:${mcpPort}: ${message}`);
  }

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
    })
  );
}

export function deactivate(): Promise<void> | undefined {
  httpServer?.dispose();
  httpServer = undefined;
  return controller?.stop();
}

function getMcpPort(): number {
  const configuredPort = vscode.workspace.getConfiguration("broker").get<number>("mcpPort", 14711);
  if (Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort <= 65535) {
    return configuredPort;
  }
  return 14711;
}

function getOrCreateMcpToken(): string {
  const tokenDir = path.join(os.homedir(), ".broker-chat");
  const tokenPath = path.join(tokenDir, "mcp-token");

  try {
    const existingToken = fs.readFileSync(tokenPath, "utf8").trim();
    if (existingToken) {
      return existingToken;
    }
  } catch {
    // Missing token is expected on first run.
  }

  const token = crypto.randomBytes(32).toString("hex");
  fs.mkdirSync(tokenDir, { recursive: true });
  fs.writeFileSync(tokenPath, token, { encoding: "utf8", mode: 0o600 });
  return token;
}
