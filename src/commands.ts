import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { CodeBlockExecution, CellOutput } from "./types";
import { WebviewManager } from "./webview";
import { StateManager } from "./state_io";
import { EnvironmentManager, truncatePath } from "./env_setup";
import { RunnerRegistry } from "./runnerRegistry";
import {
  extractCodeBlocks,
  parseMarkdownContent,
  extractCodeFromRange,
  findLanguageForRange,
} from "./codeBlockParser";

// docPath -> default folder path for JSON
const docDefaultPaths = new Map<string, string>();

function setDefaultPathForDoc(docPath: string, newFolder: string) {
  docDefaultPaths.set(docPath, newFolder);
}

function getDefaultPathForDoc(docPath: string): string | undefined {
  return docDefaultPaths.get(docPath);
}

function getDocPath(editor: vscode.TextEditor | undefined): string | undefined {
  if (!editor || editor.document.languageId !== "markdown") {
    return undefined;
  }
  return editor.document.uri.fsPath;
}

// A callback for when the user closes the results panel
export function panelDisposedCallback(docPath: string) {
  console.log(`Panel for docPath: ${docPath} disposed.`);

  // 1) Remove the runner
  const pythonAdapter = RunnerRegistry.getInstance().getRunner("python");
  pythonAdapter?.disposeRunner(docPath);

  // 2) Remove the session
  StateManager.getInstance().removeSession(docPath);

  console.log("Runner and session removed for doc:", docPath);
}

/** Re-renders the webview panel for a given docPath. */
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
    envManager.getEnvironments(),
    envManager.getSelectedPath(),
  );
}

async function handleWebviewMessage(
  message: any,
  _context: vscode.ExtensionContext,
  panel: vscode.WebviewPanel,
) {
  const envManager = EnvironmentManager.getInstance();
  const webviewManager = WebviewManager.getInstance();
  const stateManager = StateManager.getInstance();

  const docPath = webviewManager.getDocPathForPanel(panel);
  if (!docPath) {
    vscode.window.showErrorMessage(
      "Cannot determine which file triggered the webview message.",
    );
    return;
  }

  switch (message.command) {
    case "changeEnv":
      envManager.setSelectedPath(message.pythonPath);
      vscode.window.showInformationMessage(
        `Switched to: ${message.pythonPath}`,
      );
      break;

    case "changeMaxHeight":
      webviewManager.setMaxResultHeight(docPath, message.value);
      updatePanel(docPath);
      break;

    case "loadResults":
      await handleLoadResults(docPath, panel);
      break;

    case "saveAs":
      await handleSaveAs(docPath);
      break;

    case "save":
      await handleSave(docPath);
      break;

    case "clearState": {
      // Clear runner's global Python variables
      const pythonAdapter = RunnerRegistry.getInstance().getRunner("python");
      pythonAdapter?.clearState(docPath);

      // Reset the session's codeBlocks
      stateManager.clearSession(docPath);

      // Refresh the panel so the user sees a blank output
      updatePanel(docPath);

      vscode.window.showInformationMessage(
        `Cleared state for doc: ${path.basename(docPath)}`,
      );
      break;
    }
  }
}

export async function startSessionHandler(context: vscode.ExtensionContext) {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== "markdown") {
    vscode.window.showErrorMessage("Please open a Markdown file first");
    return;
  }

  const mdFullPath = editor.document.uri.fsPath;
  const stateManager = StateManager.getInstance();
  const webviewManager = WebviewManager.getInstance();
  const envManager = EnvironmentManager.getInstance();

  // If we already have a session for this file, reveal its panel
  if (stateManager.hasSession(mdFullPath)) {
    webviewManager.revealPanel(mdFullPath);
    vscode.window.showInformationMessage(
      "Session is already active for this file!",
    );
    return;
  }

  // Otherwise, create a new session for this file
  await envManager.initialize();

  // Create a Webview panel for this file
  const filename = path.basename(mdFullPath, ".md");
  const title = `${filename} Results`;
  await webviewManager.ensurePanel(
    context,
    mdFullPath,
    handleWebviewMessage,
    panelDisposedCallback,
    title,
  );

  // Tell pythonAdapter to start the process for this doc
  const pythonPath = envManager.getSelectedPath();
  const pythonAdapter = RunnerRegistry.getInstance().getRunner("python");
  if (pythonAdapter && "startProcessForDoc" in pythonAdapter) {
    (pythonAdapter as any).startProcessForDoc(mdFullPath, pythonPath);
  }

  // Attempt to load previous state
  const existingState = stateManager.tryLoadPreviousState(mdFullPath);

  // Parse code blocks
  const markdown = editor.document.getText();
  const tokens = parseMarkdownContent(markdown);
  const codeBlocks = extractCodeBlocks(tokens);

  if (existingState) {
    // Load previous session data
    stateManager.setSession(mdFullPath, existingState.session);
    const panel = webviewManager.getPanel(mdFullPath);
    if (panel) {
      panel.webview.postMessage({
        command: "updateLoadedPath",
        path: truncatePath(existingState.filePath),
      });
    }

    // Add new code blocks that might not exist in the old state
    const currSession = stateManager.getSession(mdFullPath)!;
    codeBlocks.forEach((block) => {
      const blockId = `block-${block.position}`;
      if (!currSession.codeBlocks.has(blockId)) {
        currSession.codeBlocks.set(blockId, {
          ...block,
          metadata: { status: "pending", timestamp: Date.now() },
          outputs: [],
        });
      }
    });

    vscode.window.showInformationMessage("Previous session state loaded.");
  } else {
    // Create a fresh session
    const blockMap = new Map<string, CodeBlockExecution>();
    codeBlocks.forEach((block) => {
      const blockId = `block-${block.position}`;
      blockMap.set(blockId, {
        ...block,
        metadata: {
          status: "pending",
          timestamp: Date.now(),
        },
        outputs: [],
      });
    });

    const newState = {
      codeBlocks: blockMap,
      currentBlockIndex: 0,
      runCount: 0,
    };
    stateManager.setSession(mdFullPath, newState);
    vscode.window.showInformationMessage("New session started!");
  }

  updatePanel(mdFullPath);
}

export async function runBlockHandler(
  context: vscode.ExtensionContext,
  range: vscode.Range,
) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }

  const docPath = getDocPath(editor);
  if (!docPath) {
    vscode.window.showErrorMessage("Please open a Markdown file first.");
    return;
  }

  // Make sure user has started a session for this file
  const stateManager = StateManager.getInstance();
  if (!stateManager.hasSession(docPath)) {
    vscode.window.showErrorMessage(
      `No active Drafty session for: ${path.basename(docPath)}. Please run "Drafty: Start Session" first.`,
    );
    return;
  }

  const code = extractCodeFromRange(editor.document, range);
  const language = findLanguageForRange(editor.document, range);

  await runSingleCodeBlock(context, docPath, code, range.start.line, language);
}

async function runSingleCodeBlock(
  context: vscode.ExtensionContext,
  docPath: string,
  code: string,
  position: number,
  language: string,
) {
  const webviewManager = WebviewManager.getInstance();
  const envManager = EnvironmentManager.getInstance();
  const stateManager = StateManager.getInstance();

  // Ensure panel is open or reveal it
  await webviewManager.ensurePanel(
    context,
    docPath,
    handleWebviewMessage,
    panelDisposedCallback,
  );
  webviewManager.revealPanel(docPath);

  // Retrieve the existing session for this doc
  const currentState = stateManager.getSession(docPath);
  if (!currentState) {
    vscode.window.showErrorMessage(`No session found for file: ${docPath}`);
    return;
  }

  currentState.runCount++;
  const runNumber = currentState.runCount;
  const blockId = `block-${position}`;

  const blockExecution: CodeBlockExecution = {
    content: code,
    info: language,
    position,
    metadata: {
      status: "running",
      timestamp: Date.now(),
      runNumber,
    },
    outputs: [],
  };

  // Place or replace in the map
  currentState.codeBlocks.set(blockId, blockExecution);
  updatePanel(docPath);

  // Ask webview to scroll to this block
  const panel = webviewManager.getPanel(docPath);
  panel?.webview.postMessage({
    command: "scrollToBlock",
    blockId,
  });

  // Runner
  const runner = RunnerRegistry.getInstance().getRunner(language.toLowerCase());
  if (!runner) {
    blockExecution.metadata.status = "error";
    blockExecution.outputs = [
      {
        type: "error",
        timestamp: Date.now(),
        error: `No runner available for language: ${language}`,
        traceback: [],
      },
    ];
    updatePanel(docPath);
    return;
  }

  const onPartialOutput = (partialOutput: CellOutput) => {
    const currSession = stateManager.getSession(docPath);
    if (!currSession) return;

    const block = currSession.codeBlocks.get(blockId);
    if (!block) return;

    if (partialOutput.type === "image") {
      // Overwrite old images from same run
      const oldImageIndex = block.outputs.findIndex((o) => o.type === "image");
      if (oldImageIndex !== -1) {
        block.outputs[oldImageIndex] = partialOutput;
      } else {
        block.outputs.push(partialOutput);
      }
    } else {
      block.outputs.push(partialOutput);
    }

    panel?.webview.postMessage({
      command: "partialOutput",
      blockId,
      output: partialOutput,
    });
  };

  try {
    await runner.executeCode(
      docPath,
      code,
      envManager.getSelectedPath(),
      blockId,
      onPartialOutput,
    );
    blockExecution.metadata.status = "success";
  } catch (error) {
    const errStr = error instanceof Error ? error.message : String(error);
    blockExecution.outputs = [
      {
        type: "error",
        timestamp: Date.now(),
        error: errStr,
        traceback: [],
      },
    ];
    blockExecution.metadata.status = "error";
  }

  blockExecution.metadata.executionTime =
    Date.now() - blockExecution.metadata.timestamp;
  updatePanel(docPath);
}

export async function terminateBlockHandler(
  _context: vscode.ExtensionContext,
  _range: vscode.Range,
) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }

  const docPath = getDocPath(editor);
  if (!docPath) {
    vscode.window.showErrorMessage("Please open a Markdown file first.");
    return;
  }

  const stateManager = StateManager.getInstance();
  if (!stateManager.hasSession(docPath)) {
    vscode.window.showErrorMessage(
      `No active session for file: ${path.basename(docPath)}. Please run "Drafty: Start Session" first.`,
    );
    return;
  }

  const currentState = stateManager.getSession(docPath);
  if (!currentState) {
    vscode.window.showErrorMessage(`No session found for file: ${docPath}`);
    return;
  }

  // Send SIGINT to the Python process
  const pythonAdapter = RunnerRegistry.getInstance().getRunner("python");
  if (pythonAdapter && "terminateExecution" in pythonAdapter) {
    (pythonAdapter as any).terminateExecution(docPath);
    vscode.window.showInformationMessage(
      `Sent interrupt signal to Python process for ${path.basename(docPath)}`,
    );
  } else {
    vscode.window.showErrorMessage(
      "Python runner does not support interruption",
    );
  }
}

async function handleLoadResults(docPath: string, panel: vscode.WebviewPanel) {
  // Open a file dialog
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
  setDefaultPathForDoc(docPath, folder);

  // Read the JSON
  let loadedData: any;
  try {
    const raw = fs.readFileSync(selectedFilePath, "utf-8");
    loadedData = JSON.parse(raw);
  } catch (err) {
    vscode.window.showErrorMessage(`Failed to parse JSON: ${err}`);
    return;
  }

  // Convert that loadedData to a SessionState (or merge into session).
  const stateManager = StateManager.getInstance();
  const newSession = stateManager.deserializeSessionState(loadedData);
  stateManager.setSession(docPath, newSession);

  updatePanel(docPath);

  // Send a message back to the webview to show the loaded file
  panel.webview.postMessage({
    command: "updateLoadedPath",
    path: truncatePath(selectedFilePath),
  });

  vscode.window.showInformationMessage("Loaded results from JSON!");
}

async function handleSaveAs(docPath: string) {
  const saveUri = await vscode.window.showSaveDialog({
    filters: { "JSON Files": ["json"] },
    saveLabel: "Save Results As",
  });
  if (!saveUri) {
    return; // user canceled
  }

  const saveFilePath = saveUri.fsPath;
  const folder = path.dirname(saveFilePath);
  setDefaultPathForDoc(docPath, folder);

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

async function handleSave(docPath: string) {
  const stateManager = StateManager.getInstance();
  const session = stateManager.getSession(docPath);
  if (!session) {
    vscode.window.showErrorMessage(
      "No session to save. Please run or load results first.",
    );
    return;
  }

  // If defaultPath is empty, fallback to doc's folder
  let targetFolder = getDefaultPathForDoc(docPath);
  if (!targetFolder) {
    // If none stored, fallback to the extension config or doc folder
    const config = vscode.workspace.getConfiguration("drafty");
    const globalDefaultPath = config.get<string>("defaultPath") || "";
    targetFolder = globalDefaultPath || path.dirname(docPath);
  }

  // If the user put a file path in defaultPath,
  // we check if it's a folder or a file by extension:
  let stats: fs.Stats | undefined;
  try {
    stats = fs.statSync(targetFolder);
  } catch {
    /* ignore */
  }

  let finalSavePath: string;
  if (stats && stats.isDirectory()) {
    // It's a folder -> use new naming
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
    // It's presumably a file path
    finalSavePath = targetFolder;
  }

  // If savingRule = latest-only, remove older JSON relevant to this doc
  const config = vscode.workspace.getConfiguration("drafty");
  const savingRule = config.get<string>("savingRule") || "keep-all";
  if (savingRule === "latest-only") {
    tryRemovePreviousJson(docPath, finalSavePath);
  }

  // Write the new JSON
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

  setDefaultPathForDoc(docPath, path.dirname(finalSavePath));

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
      // remove it
      try {
        fs.unlinkSync(path.join(folder, f));
      } catch (err) {
        console.warn("Failed to remove old JSON file:", err);
      }
    }
  }
}
