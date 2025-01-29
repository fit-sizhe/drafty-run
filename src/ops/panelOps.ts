import * as path from "path";
import * as vscode from "vscode";
import { panelTopOps } from "./panelTopOps";

import { RunnerRegistry } from "../runnerRegistry";
import { StateManager } from "../state";
import { EnvironmentManager } from "../env";
import { WebviewManager } from "../webview";

export namespace panelOps {
  export function updatePanel(docPath: string) {
    const webviewManager = WebviewManager.getInstance();
    const envManager = EnvironmentManager.getInstance();
    const stateManager = StateManager.getInstance();

    const session = stateManager.getSession(docPath);
    if (!session) {
      return;
    }
    webviewManager.updateContent(
      docPath,
      session.codeBlocks,
      session.bellyGroups??[],
      envManager.getEnvironments(),
      envManager.getSelectedPath(docPath),
    );
  }

  export function panelDisposedCallback(docPath: string) {
    console.log(`Panel for docPath: ${docPath} disposed.`);

    const pythonAdapter = RunnerRegistry.getInstance().getRunner("python");
    pythonAdapter?.disposeRunner(docPath);

    StateManager.getInstance().removeSession(docPath);
    console.log("Runner and session removed for doc:", docPath);
  }

  export async function handleWebviewMessage(
    message: any,
    _context: vscode.ExtensionContext,
    panel: vscode.WebviewPanel,
  ) {
    const envManager = EnvironmentManager.getInstance();
    const webviewManager = WebviewManager.getInstance();
    const stateManager = StateManager.getInstance();
    const pythonManager = RunnerRegistry.getInstance().getRunner("python");

    const docPath = webviewManager.getDocPathForPanel(panel);
    if (!docPath) {
      vscode.window.showErrorMessage(
        "Cannot determine which file triggered the webview message.",
      );
      return;
    }

    switch (message.command) {
      case "changeEnv": {
        if (pythonManager) {
          pythonManager.disposeRunner(docPath);
          pythonManager.startProcessForDoc(docPath, message.pythonPath);
        }
        envManager.setSelectedPath(message.pythonPath, docPath);
        vscode.window.showInformationMessage(
          `Switched to: ${message.pythonPath}`,
        );
        break;
      }

      case "refreshEnv": {
        const curBin = envManager.getSelectedPath(docPath);
        vscode.window.showInformationMessage(`Refreshing Environments...`);
        await envManager.refresh(docPath);
        updatePanel(docPath);
        const newBin = envManager.getSelectedPath(docPath);
        if (curBin !== newBin && pythonManager) {
          pythonManager.disposeRunner(docPath);
          pythonManager.startProcessForDoc(docPath, newBin);
          envManager.setSelectedPath(newBin, docPath);
          vscode.window.showInformationMessage(`Switched to: ${newBin}`);
        } else {
          vscode.window.showInformationMessage(`Done Env Refresh`);
        }
        break;
      }

      case "changeMaxHeight":
        webviewManager.setMaxResultHeight(docPath, message.value);
        updatePanel(docPath);
        break;

      case "loadResults":
        await panelTopOps.handleLoadResults(docPath, panel);
        break;

      case "saveAs":
        await panelTopOps.handleSaveAs(docPath);
        break;

      case "save":
        await panelTopOps.handleSave(docPath);
        break;

      case "clearState": {
        pythonManager?.clearState(docPath);
        stateManager.clearSession(docPath);
        updatePanel(docPath);
        vscode.window.showInformationMessage(
          `Cleared state for doc: ${path.basename(docPath)}`,
        );
        break;
      }
    }
  }
}
