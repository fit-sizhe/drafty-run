import * as vscode from "vscode";
import { WebviewManager } from "./webview";
import { EnvironmentManager } from "./env_setup";
import { StateManager } from "./state_io";
import { RunnerRegistry } from "./runnerRegistry";
import { MarkdownCodeLensProvider } from "./codeLensProvider";
import { commands } from "./commands";

export function activate(context: vscode.ExtensionContext) {
  console.log("Drafty is now active");

  // Register commands
  const startSessionCmd = vscode.commands.registerCommand(
    "drafty.startSession",
    () => commands.startSessionHandler(context),
  );
  const runBlockCmd = vscode.commands.registerCommand(
    "drafty.runBlock",
    (range: vscode.Range) => commands.runBlockHandler(context, range),
  );
  const terminateBlockCmd = vscode.commands.registerCommand(
    "drafty.terminateBlock",
    (range: vscode.Range) => commands.terminateBlockHandler(context, range),
  );
  // const bindBlockCmd = vscode.commands.registerCommand(
  //   "drafty.bindBlock",
  //   (range: vscode.Range) => commands.bindBlockHandler(context, range),
  // );


  // Register commands and CodeLens provider
  context.subscriptions.push(startSessionCmd, runBlockCmd, terminateBlockCmd);
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      "markdown",
      new MarkdownCodeLensProvider(),
    ),
  );

  // Listen for when a Markdown doc is closed
  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument((doc) => {
      if (doc.languageId === "markdown") {
        const docPath = doc.uri.fsPath;
        // Remove runner
        const pythonAdapter = RunnerRegistry.getInstance().getRunner("python");
        pythonAdapter?.disposeRunner(docPath);
        // Remove session from StateManager
        StateManager.getInstance().removeSession(docPath);

        console.log(`Removed runner and session for closed doc: ${docPath}`);
      }
    }),
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
  RunnerRegistry.getInstance().disposeAll();

  console.log("Drafty extension deactivated");
}
