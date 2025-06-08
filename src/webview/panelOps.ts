import * as path from "path";
import * as vscode from "vscode";
import { panelTopOps } from "./panelTopOps";

import { KernelServerRegistry } from "../kernel/KernelServerRegistry";
import { StateManager } from "../managers/StateManager";
import { EnvironmentManager } from "../managers/EnvironmentManager";
import { WebviewManager } from "./WebviewManager";
import { Input, Slider } from "../parser/directives";
import { findCodeBlockRangeByDraftyId } from "../utils/draftyIdUtils";

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
      session.bellyGroups ?? [],
      envManager.getEnvironments(),
      envManager.getSelectedBin(docPath)
    );
  }

  export function panelDisposedCallback(docPath: string) {
    console.log(`Panel for docPath: ${docPath} disposed.`);

    const pythonAdapter =
      KernelServerRegistry.getInstance().getRunner("python");
    pythonAdapter?.disposeServer(docPath);

    StateManager.getInstance().removeSession(docPath);
    console.log("Runner and session removed for doc:", docPath);
  }

  export async function handleWebviewMessage(
    message: any,
    _context: vscode.ExtensionContext,
    panel: vscode.WebviewPanel
  ) {
    const envManager = EnvironmentManager.getInstance();
    const webviewManager = WebviewManager.getInstance();
    const stateManager = StateManager.getInstance();
    const pythonManager =
      KernelServerRegistry.getInstance().getRunner("python");

    const docPath = webviewManager.getDocPathForPanel(panel);
    if (!docPath) {
      vscode.window.showErrorMessage(
        "Cannot determine which file triggered the webview message."
      );
      return;
    }

    switch (message.command) {
      case "debug": {
        console.log(message);
        break;
      }

      case "runDirectiveUpdate": {
        let msg = message.msg;
        let block = stateManager
          .getSession(docPath)
          ?.codeBlocks.get(msg.drafty_id);
        let newCurrents = new Map<string, string | number>();
        newCurrents.set(msg.param, msg.current);
        await pythonManager?.runDirectiveUpdate(
          docPath,
          msg.drafty_id,
          newCurrents,
          panel,
          block
        );
        break;
      }

      case "changeEnv": {
        if (pythonManager) {
          pythonManager.disposeServer(docPath);
          pythonManager.startProcessForDoc(docPath, message.pythonPath);
        }
        envManager.setSelectedPath(message.pythonPath, docPath);
        vscode.window.showInformationMessage(
          `Switched to: ${message.pythonPath}`
        );
        break;
      }

      case "refreshEnv": {
        const curBin = envManager.getSelectedBin(docPath);
        vscode.window.showInformationMessage(`Refreshing Environments...`);
        await envManager.refresh(docPath);
        const newBin = envManager.getSelectedBin(docPath);
        // trigger gui updates here
        await webviewManager.getPanel(docPath)?.webview.postMessage({
          command: "updateEnvOptions",
          envs: envManager.getEnvironments(),
          selected: newBin,
        });
        if (curBin !== newBin && pythonManager) {
          pythonManager.disposeServer(docPath);
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
        await webviewManager.getPanel(docPath)?.webview.postMessage({
          command: "clearBody",
        });
        vscode.window.showInformationMessage(
          `Cleared state for doc: ${path.basename(docPath)}`
        );
        break;
      }

      case "scrollToCodeBlock": {
        try {
          // Open the document first to ensure it's the active editor
          const document = await vscode.workspace.openTextDocument(vscode.Uri.file(docPath));
          const editor = await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
          
          const range = findCodeBlockRangeByDraftyId(editor.document, message.draftyId);
          
          if (range) {
            editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
            editor.selection = new vscode.Selection(range.start, range.start);
            
            // Add visual highlight that fades away
            const highlightDecorationType = vscode.window.createTextEditorDecorationType({
              backgroundColor: 'rgba(255, 255, 0, 0.2)', // Yellow highlight
              border: '1px solid rgba(255, 255, 0, 0.8)',
              borderRadius: '3px'
            });
            
            editor.setDecorations(highlightDecorationType, [range]);
            
            // Remove highlight after 2 seconds
            setTimeout(() => {
              highlightDecorationType.dispose();
            }, 1000);
          }
        } catch (error) {
          console.error("Failed to scroll to code block:", error);
          vscode.window.showErrorMessage(`Failed to navigate to code block: ${message.draftyId}`);
        }
        break;
      }
    }
  }
}
