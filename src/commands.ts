import * as vscode from "vscode";
import * as path from "path";

import { pathOps } from "./ops/pathOps";
import { panelOps } from "./ops/panelOps";

import { CodeBlockExecution } from "./types"; // or wherever you keep types
import { WebviewManager } from "./webview"; // adjust path
import { StateManager } from "./state_io"; // adjust path
import { EnvironmentManager, truncatePath } from "./env_setup"; // adjust path
import { RunnerRegistry } from "./runnerRegistry"; // adjust path
import {
  extractCodeBlocks,
  parseMarkdownContent,
  extractCodeFromRange,
  findLanguageForRange,
} from "./codeBlockParser";

export namespace commands {
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

    if (stateManager.hasSession(mdFullPath)) {
      webviewManager.revealPanel(mdFullPath);
      vscode.window.showInformationMessage(
        "Session is already active for this file!",
      );
      return;
    }

    await envManager.initialize();
    while (envManager.getEnvironments().length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const filename = path.basename(mdFullPath, ".md");
    const title = `${filename} Results`;
    await webviewManager.ensurePanel(
      context,
      mdFullPath,
      panelOps.handleWebviewMessage,
      panelOps.panelDisposedCallback,
      title,
    );

    const firstEnv = envManager.getEnvironments()[0];
    const pythonPath = firstEnv.path;
    const pythonAdapter = RunnerRegistry.getInstance().getRunner("python");

    if (pythonAdapter) {
      pythonAdapter.disposeRunner(mdFullPath);
      pythonAdapter.startProcessForDoc(mdFullPath, pythonPath);
    }
    envManager.setSelectedPath(pythonPath, mdFullPath);

    // Attempt to load previous state
    const existingState = stateManager.tryLoadPreviousState(mdFullPath);

    // Parse code blocks
    const markdown = editor.document.getText();
    const tokens = parseMarkdownContent(markdown);
    const codeBlocks = extractCodeBlocks(tokens);

    if (existingState) {
      stateManager.setSession(mdFullPath, existingState.session);
      const panel = webviewManager.getPanel(mdFullPath);
      if (panel) {
        panel.webview.postMessage({
          command: "updateLoadedPath",
          path: truncatePath(existingState.filePath),
        });
      }

      // Merge new code blocks into existing session
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
      // New session
      const blockMap = new Map<string, CodeBlockExecution>();
      codeBlocks.forEach((block) => {
        const blockId = `block-${block.position}`;
        blockMap.set(blockId, {
          ...block,
          metadata: { status: "pending", timestamp: Date.now() },
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

    panelOps.updatePanel(mdFullPath);
  }

  export async function runBlockHandler(
    context: vscode.ExtensionContext,
    range: vscode.Range,
  ) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }

    const docPath = pathOps.getDocPath(editor);
    if (!docPath) {
      vscode.window.showErrorMessage("Please open a Markdown file first.");
      return;
    }

    const stateManager = StateManager.getInstance();
    if (!stateManager.hasSession(docPath)) {
      vscode.window.showErrorMessage(
        `No active Drafty session for: ${path.basename(docPath)}. ` +
        `Please run "Drafty: Start Session" first.`,
      );
      return;
    }

    const code = extractCodeFromRange(editor.document, range);
    const language = findLanguageForRange(editor.document, range);

    await runSingleCodeBlock(
      context,
      docPath,
      code,
      range.start.line,
      language,
    );
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

    await webviewManager.ensurePanel(
      context,
      docPath,
      panelOps.handleWebviewMessage,
      panelOps.panelDisposedCallback,
    );
    webviewManager.revealPanel(docPath);

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

    currentState.codeBlocks.set(blockId, blockExecution);
    panelOps.updatePanel(docPath);

    const panel = webviewManager.getPanel(docPath);
    panel?.webview.postMessage({
      command: "scrollToBlock",
      blockId,
    });

    const runner = RunnerRegistry.getInstance().getRunner(
      language.toLowerCase(),
    );
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
      panelOps.updatePanel(docPath);
      return;
    }

    const onPartialOutput = (partialOutput: any) => {
      const currSession = stateManager.getSession(docPath);
      if (!currSession) return;
      const block = currSession.codeBlocks.get(blockId);
      if (!block) return;

      if (partialOutput.type === "image") {
        // Overwrite old images from the same run
        const oldImageIndex = block.outputs.findIndex(
          (o) => o.type === "image",
        );
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
        envManager.getSelectedPath(docPath),
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
    panelOps.updatePanel(docPath);
  }

  export async function terminateBlockHandler(
    _context: vscode.ExtensionContext,
    _range: vscode.Range,
  ) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }

    const docPath = pathOps.getDocPath(editor);
    if (!docPath) {
      vscode.window.showErrorMessage("Please open a Markdown file first.");
      return;
    }

    const stateManager = StateManager.getInstance();
    if (!stateManager.hasSession(docPath)) {
      vscode.window.showErrorMessage(
        `No active session for file: ${path.basename(docPath)}. ` +
        `Please run "Drafty: Start Session" first.`,
      );
      return;
    }

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

  //  bindBlockHandler
  export function bindBlockHandler(
    _context: vscode.ExtensionContext,
    _range: vscode.Range,
  ) {
  }
}
