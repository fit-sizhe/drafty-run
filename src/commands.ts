import * as vscode from "vscode";
import * as path from "path";

import { pathUtils } from "./utils/pathUtils";
import { panelOps } from "./webview/panelOps";

import { CodeBlockExecution } from "./types"; 
import { WebviewManager } from "./webview/WebviewManager";
import { SessionState, StateManager } from "./managers/StateManager"; 
import { EnvironmentManager, truncatePath } from "./managers/EnvironmentManager";
import { KernelServerRegistry } from "./kernel/KernelServerRegistry";
import {
  extractCodeBlocks,
  parseMarkdownContent,
  findMetaForRange,
} from "./parser/block";
import { parseDraftyId } from "./parser/draftyid";
import * as draftyid_utils from "./utils/draftyIdUtils";

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
    const pythonAdapter = KernelServerRegistry.getInstance().getRunner("python");

    if (pythonAdapter) {
      pythonAdapter.disposeServer(mdFullPath);
      try {
        await pythonAdapter.startProcessForDoc(mdFullPath, pythonPath);
      } catch (error: any) {
        // Show user-friendly error message
        vscode.window.showErrorMessage(error.message || 'Failed to start Python kernel');
        return; // Don't continue with session setup if kernel failed
      }
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
    // 1. Environment Checks
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }

    const docPath = pathUtils.getDocPath(editor);
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

    // 2. Open Corresponding Webview
    const webviewManager = WebviewManager.getInstance();
    await webviewManager.ensurePanel(
      context,
      docPath,
      panelOps.handleWebviewMessage,
      panelOps.panelDisposedCallback,
    );
    webviewManager.revealPanel(docPath);

    // 3. Extract Code and Metadata Before Changes
    // directive extraction is bundled in runDirectiveInit/runDirectiveUpdate
    const {code, language, title, stream} = findMetaForRange(editor.document, range);


    // 4. Ensure Drafty ID
    const currentSession = stateManager.getSession(docPath) as SessionState;
    // if nothing found, add the line
    // range is invalidated after this line
    let foundId = await draftyid_utils.ensureDraftyIdInCodeBlock(editor, range);
    // sync all block IDs from the doc
    // at this point, all code blocks should have a DRAFTY-ID
    // the function also dispatch the command "reorder blocks"
    await draftyid_utils.syncAllDraftyIds(editor.document, currentSession, foundId);

    // 5. Update Block Status
    currentSession.runCount++;
    // retrieve that block from session (it should exist after syncAllDraftyIds).
    let blockInSession = currentSession.codeBlocks.get(foundId);
    if (!blockInSession) {
      // if for some reason it doesn't exist, create it now
      blockInSession = {
        content: code,
        info: language??"",
        language: language??"",
        bindingId: parseDraftyId(foundId),
        position: range.start.line, // optional
        title: title??"",
        stream: stream,
        metadata: {
          status: "running",
          timestamp: Date.now(),
          bindingId: foundId,
          runNumber: currentSession.runCount,
        },
        outputs: [],
      };
      currentSession.codeBlocks.set(foundId, blockInSession);
    } else {
      // reuse old block, but update `content` + language
      blockInSession.outputs = [];
      blockInSession.content = code;
      blockInSession.info = language??"";
      blockInSession.language = language??"";
      blockInSession.title = title??"";
      blockInSession.stream = stream;
      blockInSession.position = range.start.line; // optional
      blockInSession.metadata.status = "running";
      blockInSession.metadata.timestamp = Date.now();
      blockInSession.metadata.bindingId = foundId;
      blockInSession.metadata.runNumber = currentSession.runCount;
    }

    // instead of re-rendering, we simply update status info
    webviewManager.updateBlockStatus(
      docPath, 
      blockInSession.metadata.bindingId!, 
      "running", 
      currentSession.runCount,
      true, // clear content
      blockInSession.title,
    );

    // ask webview to scroll to this block
    const panel = webviewManager.getPanel(docPath);
    panel?.webview.postMessage({
      command: "scrollToBlock",
      blockId: foundId,
    });

    // 6. Get Kernel Server to Run Code
    const server = KernelServerRegistry.getInstance().getRunner(
      language??"".toLowerCase(),
    );
    if (!server) {
      vscode.window.showErrorMessage(`No Kernel Server Found for ${language}.`);
      return;
    }

    try{
      await server.runSingleBlock(
        docPath, 
        code, 
        blockInSession,webviewManager.getPanel(docPath));
      // status might be set to "error" in runDirectiveInit
      await server.runDirectiveInit(
        docPath,
        code,
        blockInSession,
        webviewManager.getPanel(docPath));
      // check if any errors found
      blockInSession.outputs.forEach(o=>{
        o.type === "error"?blockInSession.metadata.status = "error":null;
      })
      if (blockInSession.metadata.status != "error") {
        blockInSession.metadata.status = "success";
      }
    } catch(error) {
      const errStr = error instanceof Error ? error.message : String(error);
      blockInSession.outputs = [
        {
          type: "error",
          timestamp: Date.now(),
          error: errStr,
          traceback: [],
        },
      ];
      blockInSession.metadata.status = "error";
    }
    // blockInSession.metadata.executionTime = blockInSession.metadata.executionStartTime
    //   ? Date.now() - blockInSession.metadata.executionStartTime
    //   : Date.now() - blockInSession.metadata.timestamp;

    webviewManager.updateBlockStatus(
      docPath, 
      blockInSession.metadata.bindingId!,
      blockInSession.metadata.status, 
      currentSession.runCount,
      false, // do not clear
      blockInSession.title,
      blockInSession.metadata.executionTime
    );
  }

  export async function terminateBlockHandler(
    _context: vscode.ExtensionContext,
    _range: vscode.Range,
  ) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }

    const docPath = pathUtils.getDocPath(editor);
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

    const pythonAdapter = KernelServerRegistry.getInstance().getRunner("python");
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

  export async function gotoBlockHandler(
    context: vscode.ExtensionContext,
    range: vscode.Range,
  ) {

    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }

    const docPath = pathUtils.getDocPath(editor);
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

    const webviewManager = WebviewManager.getInstance();
    await webviewManager.ensurePanel(
      context,
      docPath,
      panelOps.handleWebviewMessage,
      panelOps.panelDisposedCallback,
    );
    webviewManager.revealPanel(docPath);

    let foundId = await draftyid_utils.ensureDraftyIdInCodeBlock(editor, range);

    const panel = webviewManager.getPanel(docPath);
    panel?.webview.postMessage({
      command: "scrollToBlock",
      blockId: foundId,
    });
  }

  export async function runAllBlocksHandler(
    context: vscode.ExtensionContext,
    documentUri: vscode.Uri,
  ) {
    const docPath = documentUri.fsPath;
    const editor = vscode.window.activeTextEditor;
    
    if (!editor || editor.document.uri.fsPath !== docPath) {
      vscode.window.showErrorMessage("Please open the markdown file first.");
      return;
    }

    const stateManager = StateManager.getInstance();
    const webviewManager = WebviewManager.getInstance();
    
    // Start session if not already started
    if (!stateManager.hasSession(docPath)) {
      await startSessionHandler(context);
      vscode.window.showInformationMessage(`Click "Run All" again to run all blocks`);
      return;
    }

    // Ensure webview panel is created and visible
    await webviewManager.ensurePanel(
      context,
      docPath,
      panelOps.handleWebviewMessage,
      panelOps.panelDisposedCallback,
    );
    webviewManager.revealPanel(docPath);

    // Parse all Python code blocks from the document
    const markdown = editor.document.getText();
    const tokens = parseMarkdownContent(markdown);
    const codeBlocks = extractCodeBlocks(tokens).filter(block => 
      block.language === "python"
    );

    vscode.window.showInformationMessage(`Running ${codeBlocks.length} Python code blocks sequentially...`);

    // Run each code block sequentially
    for (let i = 0; i < codeBlocks.length; i++) {
      const block = codeBlocks[i];
      const startLine = block.position;
      
      // Find the end line of the code block
      const lines = editor.document.getText().split('\n');
      let endLine = startLine + 1;
      for (let j = startLine + 1; j < lines.length; j++) {
        if (lines[j].includes('```')) {
          endLine = j;
          break;
        }
      }
      
      const range = new vscode.Range(startLine, 0, endLine, 0);
      
      try {
        await runBlockHandler(context, range);
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to run block ${i + 1}: ${error}`);
        break;
      }
    }

    vscode.window.showInformationMessage("Finished running all Python code blocks.");
  }

}
