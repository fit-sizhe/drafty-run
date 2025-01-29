import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { pathOps } from "./pathOps";

import { StateManager } from "../state";
import { truncatePath } from "../env";
import { WebviewManager } from "../webview";
import { EnvironmentManager } from "../env";

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
      envManager.getSelectedPath(docPath),
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
    pathOps.setDefaultPathForDoc(docPath, folder);

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
    pathOps.setDefaultPathForDoc(docPath, folder);

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
    const stateManager = StateManager.getInstance();
    const session = stateManager.getSession(docPath);
    if (!session) {
      vscode.window.showErrorMessage(
        "No session to save. Please run or load results first.",
      );
      return;
    }

    let targetFolder = pathOps.getDefaultPathForDoc(docPath);
    if (!targetFolder) {
      const config = vscode.workspace.getConfiguration("drafty");
      const globalDefaultPath = config.get<string>("defaultPath") || "";
      targetFolder = globalDefaultPath || path.dirname(docPath);
    }

    let stats: fs.Stats | undefined;
    try {
      stats = fs.statSync(targetFolder);
    } catch {
      // ignore
    }

    let finalSavePath: string;
    if (stats && stats.isDirectory()) {
      const baseName = path.basename(docPath, ".md");
      const now = new Date();
      const yyyymmdd = now.toISOString().slice(0, 10).replace(/-/g, "");
      const hhmm =
        String(now.getHours()).padStart(2, "0") +
        String(now.getMinutes()).padStart(2, "0");
      finalSavePath = path.join(
        targetFolder,
        `${baseName}-state-${yyyymmdd}-${hhmm}.json`,
      );
    } else {
      finalSavePath = targetFolder;
    }

    const config = vscode.workspace.getConfiguration("drafty");
    const savingRule = config.get<string>("savingRule") || "keep-all";
    if (savingRule === "latest-only") {
      tryRemovePreviousJson(docPath, finalSavePath);
    }

    const dataToSave = stateManager.serializeSessionState(session);
    try {
      fs.writeFileSync(
        finalSavePath,
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
        path: truncatePath(finalSavePath),
      });
    }

    pathOps.setDefaultPathForDoc(docPath, path.dirname(finalSavePath));
    vscode.window.showInformationMessage(`Results saved to: ${finalSavePath}`);
  }

  function tryRemovePreviousJson(docPath: string, finalSavePath: string) {
    const folder = path.dirname(finalSavePath);
    if (!fs.existsSync(folder)) {
      return;
    }

    const baseName = path.basename(docPath, ".md");
    const pattern = new RegExp(`^${baseName}-state-.*\\.json$`, "i");

    const allFiles = fs.readdirSync(folder);
    for (const f of allFiles) {
      if (pattern.test(f) && path.join(folder, f) !== finalSavePath) {
        try {
          fs.unlinkSync(path.join(folder, f));
        } catch (err) {
          console.warn("Failed to remove old JSON file:", err);
        }
      }
    }
  }
}
