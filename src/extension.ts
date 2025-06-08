import * as vscode from "vscode";
import { WebviewManager } from "./webview/WebviewManager";
import { EnvironmentManager } from "./managers/EnvironmentManager";
import { StateManager } from "./managers/StateManager";
import { KernelServerRegistry } from "./kernel/KernelServerRegistry";
import { MarkdownCodeLensProvider } from "./managers/codeLensProvider";
import { commands } from "./commands";

export function activate(context: vscode.ExtensionContext) {
  console.log("Drafty is now active");

  // Register commands
  const startSessionCmd = vscode.commands.registerCommand(
    "drafty.startSession",
    () => commands.startSessionHandler(context)
  );
  const runBlockCmd = vscode.commands.registerCommand(
    "drafty.runBlock",
    (range: vscode.Range) => commands.runBlockHandler(context, range)
  );
  const terminateBlockCmd = vscode.commands.registerCommand(
    "drafty.terminateBlock",
    (range: vscode.Range) => commands.terminateBlockHandler(context, range)
  );
  const gotoBlockCmd = vscode.commands.registerCommand(
    "drafty.gotoBlock",
    (range: vscode.Range) => commands.gotoBlockHandler(context, range)
  );
  const runAllBlocksCmd = vscode.commands.registerCommand(
    "drafty.runAllBlocks",
    (documentUri: vscode.Uri) => commands.runAllBlocksHandler(context, documentUri)
  );

  // Register commands and CodeLens provider
  context.subscriptions.push(
    startSessionCmd,
    runBlockCmd,
    terminateBlockCmd,
    gotoBlockCmd,
    runAllBlocksCmd
  );
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      "markdown",
      new MarkdownCodeLensProvider()
    )
  );

  // Listen for when a Markdown doc is closed
  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument((doc) => {
      if (doc.languageId === "markdown") {
        const docPath = doc.uri.fsPath;
        // Remove runner
        const pythonAdapter =
          KernelServerRegistry.getInstance().getRunner("python");
        pythonAdapter?.disposeServer(docPath);
        // Remove session from StateManager
        StateManager.getInstance().removeSession(docPath);

        console.log(`Removed runner and session for closed doc: ${docPath}`);
      }
    })
  );

  // Initialize singletons
  WebviewManager.getInstance();
  EnvironmentManager.getInstance();
  StateManager.getInstance();
}

export function deactivate() {
  const stateManager = StateManager.getInstance();
  stateManager.clearAllSessions();

  const webviewManager = WebviewManager.getInstance();
  webviewManager.disposeAllPanels();

  // Dispose all runners
  KernelServerRegistry.getInstance().disposeAll();

  console.log("Drafty extension deactivated");
}
