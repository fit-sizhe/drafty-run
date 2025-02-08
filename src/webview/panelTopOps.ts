import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";

import { StateManager } from "../managers/StateManager";
import { truncatePath } from "../managers/EnvironmentManager";
import { WebviewManager } from "./WebviewManager";
import { EnvironmentManager } from "../managers/EnvironmentManager";

export namespace panelTopOps {
  // same as updatePanel in panelOps,
  // keep duplicates to avoid cyclic import
  function updatePanel(docPath: string) {
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
      envManager.getSelectedBin(docPath),
    );
  }

  export async function handleLoadResults(
    docPath: string,
    panel: vscode.WebviewPanel,
  ) {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { "JSON Files": ["json"] },
      openLabel: "Select JSON to Load",
    });
    if (!uris || uris.length === 0) {
      return; // user canceled
    }

    const selectedUri = uris[0];
    const selectedFilePath = selectedUri.fsPath;
    const folder = path.dirname(selectedFilePath);

    let loadedData: any;
    try {
      const raw = fs.readFileSync(selectedFilePath, "utf-8");
      loadedData = JSON.parse(raw);
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to parse JSON: ${err}`);
      return;
    }

    const stateManager = StateManager.getInstance();
    const newSession = stateManager.deserializeSessionState(loadedData);
    stateManager.setSession(docPath, newSession);

    updatePanel(docPath);

    panel.webview.postMessage({
      command: "updateLoadedPath",
      path: truncatePath(selectedFilePath),
    });

    vscode.window.showInformationMessage("Loaded results from JSON!");
  }

  export async function handleSaveAs(docPath: string) {
    const saveUri = await vscode.window.showSaveDialog({
      filters: { "JSON Files": ["json"] },
      saveLabel: "Save Results As",
    });
    if (!saveUri) {
      return; // user canceled
    }

    const saveFilePath = saveUri.fsPath;
    const folder = path.dirname(saveFilePath);

    const stateManager = StateManager.getInstance();
    const session = stateManager.getSession(docPath);
    if (!session) {
      vscode.window.showErrorMessage(
        "No session to save. Please run or load results first.",
      );
      return;
    }

    const dataToSave = stateManager.serializeSessionState(session);
    try {
      fs.writeFileSync(
        saveFilePath,
        JSON.stringify(dataToSave, null, 2),
        "utf-8",
      );
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to save JSON: ${err}`);
      return;
    }

    const panel = WebviewManager.getInstance().getPanel(docPath);
    if (panel) {
      panel.webview.postMessage({
        command: "updateLoadedPath",
        path: truncatePath(saveFilePath),
      });
    }

    vscode.window.showInformationMessage(`Results saved to: ${saveFilePath}`);
  }

  export async function handleSave(docPath: string) {
    const finalSavePath = StateManager.getInstance().saveSession(docPath);
    if (!finalSavePath) return;
    const panel = WebviewManager.getInstance().getPanel(docPath);
    if (panel) {
      panel.webview.postMessage({
        command: "updateLoadedPath",
        path: truncatePath(finalSavePath),
      });
    }

    vscode.window.showInformationMessage(`Results saved to: ${finalSavePath}`);
  }
}
