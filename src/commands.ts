import * as vscode from "vscode";
import * as path from "path";

import { pathOps } from "./ops/pathOps";
import { panelOps } from "./ops/panelOps";

import { CodeBlockExecution } from "./types"; // or wherever you keep types
import { WebviewManager } from "./webview"; // adjust path
import { SessionState, StateManager } from "./state_io"; // adjust path
import { EnvironmentManager, truncatePath } from "./env_setup"; // adjust path
import { RunnerRegistry } from "./runnerRegistry"; // adjust path
import {
  extractCodeBlocks,
  parseMarkdownContent,
  extractCodeFromRange,
  findLanguageForRange,
} from "./codeBlockParser";
import * as bind_utils from "./binding_utils";

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

    const currentSession = stateManager.getSession(docPath) as SessionState;
    const code = extractCodeFromRange(editor.document, range);
    const language = findLanguageForRange(editor.document, range);

    // Try to find a DRAFTY-ID in the code block lines
    // if nothing found, add the line
    let foundId = bind_utils.ensureDraftyIdInCodeBlock(editor, range);

    // Retrieve that block from session (it should exist after syncAllBlockIds).
    const blockInSession = currentSession.codeBlocks.get(foundId);
    if (!blockInSession) {
      // If for some reason it doesn't exist, create it now
      currentSession.codeBlocks.set(foundId, {
        content: code,
        info: findLanguageForRange(editor.document, range),
        position: range.start.line, // optional
        metadata: {
          status: "pending",
          timestamp: Date.now(),
          bindingId: foundId,
        },
        outputs: [],
      });
    } else {
      // Reuse old block, but update `content` + language
      blockInSession.content = code;
      blockInSession.info = findLanguageForRange(editor.document, range);
      blockInSession.position = range.start.line; // optional
      blockInSession.metadata.status = "pending";
      blockInSession.metadata.timestamp = Date.now();
    }

    // sync all block IDs from the doc
    // at this point, all code blocks should have a DRAFTY-ID
    await bind_utils.syncAllBlockIds(editor.document, currentSession);

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

  // currently NOT using it
  export function bindBlockHandler(
    _context: vscode.ExtensionContext,
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
        `No active Drafty session for: ${path.basename(docPath)}. Please run "Drafty: Start Session" first.`,
      );
      return;
    }

    // Ensure there's a "DRAFTY-ID-xxx-y" comment in the code block
    const bindingId = bind_utils.ensureDraftyIdInCodeBlock(editor, range);

    // Parse the ID to see if it has head/belly/tail
    let parsed = bind_utils.parseDraftyId(bindingId);
    if (!parsed) {
      // If for some reason the ID didn't match the pattern, bail out:
      vscode.window.showErrorMessage(`Invalid ID format: ${bindingId}`);
      return;
    }

    // re-check if we already have blocks with the same belly+tail
    // If so, we might need to "bump" tail to the next available integer.
    const session = stateManager.getSession(docPath)!;
    const existingBlockKey = [...session.codeBlocks.keys()].find((key) => {
      // Check if this block's metadata has the same bindingId
      const block = session.codeBlocks.get(key);
      if (!block || !block.metadata || !block.metadata.bindingId) return false;
      return block.metadata.bindingId === bindingId;
    });

    if (!existingBlockKey) {
      // If no block has this exact ID, check if we need to adjust tail
      const nextTail = bind_utils.getNextTailForSameBelly(
        session.codeBlocks,
        parsed.head,
        parsed.belly,
      );
      if (nextTail !== parsed.tail) {
        // we found a collision, so let's bump to the nextTail
        parsed = { ...parsed, tail: nextTail };
      }
    }

    // Reconstruct the final ID from parsed parts
    const finalId = `${parsed.head}-${parsed.belly}-${parsed.tail}`;

    // Create or update a block in the session so it appears in the webview
    // The key in the map can be `finalId` or you can still use a separate key
    // but store `bindingId` in metadata.
    const existingBlock = existingBlockKey
      ? session.codeBlocks.get(existingBlockKey)
      : undefined;

    if (!existingBlock) {
      // brand new block in the session
      session.codeBlocks.set(finalId, {
        content: "", // empty for now
        info: "", // language not strictly needed for "bind"
        position: range.start.line,
        metadata: {
          status: "pending",
          timestamp: Date.now(),
          bindingId: finalId,
        },
        outputs: [],
      });
      vscode.window.showInformationMessage(
        `Bound new code block to ${finalId}`,
      );
    } else {
      // We already have a block with this ID; update its metadata if needed
      existingBlock.metadata.bindingId = finalId;
      vscode.window.showInformationMessage(
        `Updated existing block ID to ${finalId}`,
      );
      // if we changed the tail, we should also change the map key
      if (existingBlockKey && existingBlockKey !== finalId) {
        // session.codeBlocks.delete(existingBlockKey);
        session.codeBlocks.set(finalId, existingBlock);
      }
    }

    panelOps.updatePanel(docPath);
  }
}
