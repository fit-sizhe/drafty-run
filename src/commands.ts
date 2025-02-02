import * as vscode from "vscode";
import * as path from "path";

import { pathOps } from "./pathOps";
import { panelOps } from "./panel/panelOps";

import { CodeBlockExecution } from "./types"; // or wherever you keep types
import { WebviewManager } from "./webview"; // adjust path
import { SessionState, StateManager } from "./state"; // adjust path
import { EnvironmentManager, truncatePath } from "./env"; // adjust path
import { RunnerRegistry } from "./runnerRegistry"; // adjust path
import {
  extractCodeBlocks,
  parseMarkdownContent,
  extractCodeFromRange,
  findLanguageForRange,
  parseDraftyId,
} from "./codeBlockParser";
import * as bind_utils from "./binding";

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
        const blockId = `DRAFTY-ID-${block.bindingId?.belly||"999"}-${block.bindingId?.tail||"0"}`;
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
        const blockId = `DRAFTY-ID-${block.bindingId?.belly||"999"}-${block.bindingId?.tail||"0"}`;
        blockMap.set(blockId, {
          ...block,
          metadata: { status: "pending", timestamp: Date.now() },
          outputs: [],
        });
      });

      const newState = {
        codeBlocks: blockMap,
        bellyGroups: [],
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

    const currentSession = stateManager.getSession(docPath) as SessionState;

    // extract info/code before any change
    const code = extractCodeFromRange(editor.document, range);
    const language = findLanguageForRange(editor.document, range);

    // Try to find a DRAFTY-ID in the code block lines
    // if nothing found, add the line
    // range is invalidated after this line
    let foundId = await bind_utils.ensureDraftyIdInCodeBlock(editor, range);
    // sync all block IDs from the doc
    // at this point, all code blocks should have a DRAFTY-ID
    await bind_utils.syncAllBlockIds(editor.document, currentSession);

    // Retrieve that block from session (it should exist after syncAllBlockIds).
    const blockInSession = currentSession.codeBlocks.get(foundId);
    if (!blockInSession) {
      // If for some reason it doesn't exist, create it now
      currentSession.codeBlocks.set(foundId, {
        content: code,
        info: language,
        bindingId: parseDraftyId(foundId),
        position: range.start.line, // optional
        metadata: {
          status: "running",
          timestamp: Date.now(),
          bindingId: foundId,
        },
        outputs: [],
      });
    } else {
      // Reuse old block, but update `content` + language
      blockInSession.content = code;
      blockInSession.info = language;
      blockInSession.position = range.start.line; // optional
      blockInSession.metadata.status = "running";
      blockInSession.metadata.timestamp = Date.now();
    }


    await runSingleCodeBlock(
      context,
      docPath,
      code,
      range.start.line,
      foundId,
      language,
    );
  }

  async function runSingleCodeBlock(
    context: vscode.ExtensionContext,
    docPath: string,
    code: string,
    position: number,
    bindingId: string,
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
    let blockExecution = currentState.codeBlocks.get(bindingId);
    if (!blockExecution) {
      blockExecution = {
        content: code,
        info: language,
        position,
        bindingId: parseDraftyId(bindingId),
        metadata: {
          status: "running",
          timestamp: Date.now(),
          runNumber: currentState.runCount,
          bindingId: bindingId,
        },
        outputs: [],
      };
      currentState.codeBlocks.set(bindingId, blockExecution);
    } else {
      blockExecution.metadata.runNumber = currentState.runCount;
      blockExecution.metadata.status = "running";
      blockExecution.outputs = [];
    }

    // Re-render before we start
    panelOps.updatePanel(docPath);

    // Ask webview to scroll to this block
    const panel = webviewManager.getPanel(docPath);
    panel?.webview.postMessage({
      command: "scrollToBlock",
      blockId: bindingId,
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
      const block = currSession.codeBlocks.get(bindingId);
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
        blockId: bindingId,
        output: partialOutput,
      });
    };

    try {
      await runner.executeCode(
        docPath,
        code,
        envManager.getSelectedPath(docPath),
        bindingId,
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
    
    // TEMPORARY PATCH: make sure short executions scroll into view
    // TODO: replace "updatePanel" with fine-grained element updates
    if (panel) {
      // Create a promise to wait for scroll completion
      const scrollCompletion = new Promise<void>((resolve) => {
        const disposable = panel!.webview.onDidReceiveMessage((message) => {
          if (message.alert === 'scrollIntoViewCompleted') {
            disposable.dispose(); // Cleanup listener
            resolve();
          }
        });
      });
    
      // Send scroll command
      await panel.webview.postMessage({
        command: "scrollToBlock",
        blockId: bindingId,
      });
    
      // Wait for scroll to finish
      await scrollCompletion;
    }
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
}
