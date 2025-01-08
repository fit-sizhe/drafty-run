import * as vscode from 'vscode';
import * as path from 'path';
import * as MarkdownIt from 'markdown-it';
import { CodeBlock, CodeBlockExecution, CellOutput } from './types';
import { PythonRunner } from './pythonRunner';
import { EnvironmentManager } from './env_setup';
import { StateManager, SessionState } from './state_io';
import { WebviewManager } from './webview';
import { clear } from 'console';

// Keep track of running processes to allow termination
const runningProcesses: Map<string, any> = new Map();

// Interface for language runners
export interface ILanguageRunner {
    executeCode(
        docPath: string,
        code: string,
        envPath: string,
        blockId: string,
        onPartialOutput?: (output: CellOutput) => void
    ): { 
        process: any;
        promise: Promise<{ outputs: CellOutput[] }>;
    };
    /**
     * Clear *only* the runner's state for the given docPath,
     */
    clearState(docPath: string): void;

    /**
     * Completely remove (dispose) the runner instance for docPath from memory.
     */
    disposeRunner(docPath: string): void;
}


// Adapter to make PythonRunner match ILanguageRunner interface
class PythonRunnerAdapter implements ILanguageRunner {
    private runners = new Map<string, PythonRunner>();
    
    private getRunner(docPath: string): PythonRunner {
        if (!this.runners.has(docPath)) {
            this.runners.set(docPath, new PythonRunner());
        }
        return this.runners.get(docPath)!;
    }

    executeCode(
        docPath: string, 
        code: string, 
        envPath: string, 
        blockId: string, 
        onPartialOutput?: (output: CellOutput) => void
    ) {
        const runner = this.getRunner(docPath);
        return runner.executeCode(code, envPath, blockId, onPartialOutput);
    }

    clearState(docPath: string): void {
        const runner = this.runners.get(docPath);
        if (runner) {
            runner.clearState();
            this.runners.delete(docPath);
        }
    }

    disposeRunner(docPath: string): void {
        // Remove the runner from the map entirely
        this.runners.delete(docPath);
    }

    disposeAll(): void {
        this.runners.clear();
    }    
}

// A callback for when the user closes the results panel
function panelDisposedCallback(docPath: string) {
    console.log(`Panel for docPath: ${docPath} disposed.`);

    // 1) Remove the runner
    const pythonAdapter = languageRunners.get('python');
    pythonAdapter?.disposeRunner(docPath);

    // 2) Remove the session
    StateManager.getInstance().removeSession(docPath);

    // Optionally show a message or do other cleanup
    console.log('Runner and session removed for doc:', docPath);
}

// Registry for language runners
const languageRunners = new Map<string, ILanguageRunner>();

// Register the Python runner by default
const pythonAdapter = new PythonRunnerAdapter();
languageRunners.set('python', pythonAdapter);

export function activate(context: vscode.ExtensionContext) {
    console.log('Drafty is now active');

    const startSessionCmd = vscode.commands.registerCommand('drafty.startSession', () => startSessionHandler(context));
    const runBlockCmd = vscode.commands.registerCommand('drafty.runBlock', (range: vscode.Range) => runBlockHandler(context, range));
    const terminateBlockCmd = vscode.commands.registerCommand('drafty.terminateBlock', (range: vscode.Range) => terminateBlockHandler(context, range));

    // Register commands and CodeLens provider
    context.subscriptions.push(startSessionCmd, runBlockCmd, terminateBlockCmd);
    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider('markdown', new MarkdownCodeLensProvider())
    );

    // Listen for when a Markdown doc is closed.
    context.subscriptions.push(
        vscode.workspace.onDidCloseTextDocument((doc) => {
            if (doc.languageId === 'markdown') {
                const docPath = doc.uri.fsPath;
                // Remove runner
                const pythonAdapter = languageRunners.get('python');
                pythonAdapter?.disposeRunner(docPath);
                // Remove session from StateManager
                StateManager.getInstance().removeSession(docPath);

                console.log(`Removed runner and session for closed doc: ${docPath}`);
            }
        })
    );

    // Initialize singletons
    WebviewManager.getInstance(); 
    EnvironmentManager.getInstance();
    StateManager.getInstance();
}

////////////////////////////////////////////////////////////////////////////////
// Multi-file session & panel management
////////////////////////////////////////////////////////////////////////////////

/**
 * For each opened Markdown file, we keep:
 * - a dedicated session (SessionState) in the StateManager
 * - a dedicated WebviewPanel in the WebviewManager
 *
 * By default, StateManager and WebviewManager were singletons. 
 * Now we store state/panels by 'docPath' (the absolute path to the .md file).
 */
function getDocPath(editor: vscode.TextEditor | undefined): string | undefined {
    if (!editor || editor.document.languageId !== 'markdown') {
        return undefined;
    }
    return editor.document.uri.fsPath;
}

async function handleWebviewMessage(
    message: any, 
    context: vscode.ExtensionContext, 
    panel: vscode.WebviewPanel
) {
    const envManager = EnvironmentManager.getInstance();
    const webviewManager = WebviewManager.getInstance();
    const _stateManager = StateManager.getInstance();

    // Now, do a reverse lookup using `panel`:
    const docPath = webviewManager.getDocPathForPanel(panel);
    if (!docPath) {
        vscode.window.showErrorMessage('Cannot determine which file triggered the webview message.');
        return;
    }

    switch (message.command) {
        case 'changeEnv':
            envManager.setSelectedPath(message.pythonPath);
            vscode.window.showInformationMessage(`Switched to: ${message.pythonPath}`);
            break;

        case 'changeMaxHeight':
            webviewManager.setMaxResultHeight(docPath, message.value);
            updatePanel(docPath);
            break;

        case 'saveState':
            handleSaveState(docPath);
            break;

        case 'clearState': {
            // Clear runner's global Python variables
            const pythonAdapter = languageRunners.get('python');
            pythonAdapter?.clearState(docPath);

            // Reset the session’s codeBlocks
            const stateManager = StateManager.getInstance();
            stateManager.clearSession(docPath);

            // Refresh the panel so the user sees a blank output
            updatePanel(docPath);

            vscode.window.showInformationMessage(`Cleared state for doc: ${path.basename(docPath)}`);
            break;
        }

        default:
            // no-op
            break;
    }
}

async function startSessionHandler(context: vscode.ExtensionContext) {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'markdown') {
        vscode.window.showErrorMessage('Please open a Markdown file first');
        return;
    }

    const mdFullPath = editor.document.uri.fsPath;
    const stateManager = StateManager.getInstance();
    const webviewManager = WebviewManager.getInstance();
    const envManager = EnvironmentManager.getInstance();

    // If we already have a session for this file, reveal its panel
    if (stateManager.hasSession(mdFullPath)) {
        webviewManager.revealPanel(mdFullPath);
        vscode.window.showInformationMessage('Session is already active for this file!');
        return;
    }

    // Otherwise, create a new session for this file
    await envManager.initialize();

    // Create a Webview panel for this file
    const filename = path.basename(mdFullPath, '.md');
    const title = `${filename} Results`;
    await webviewManager.ensurePanel(
        context, 
        mdFullPath, 
        handleWebviewMessage, 
        panelDisposedCallback, 
        title
    );

    // Attempt to load previous state
    const existingState = stateManager.tryLoadPreviousState(mdFullPath);

    // Parse code blocks
    const markdown = editor.document.getText();
    const md = new MarkdownIt();
    const tokens = md.parse(markdown, {});
    const codeBlocks = extractCodeBlocks(tokens);

    if (existingState) {
        // Load previous session data
        stateManager.setSession(mdFullPath, existingState);

        // Add new code blocks that might not exist in the old state
        const currSession = stateManager.getSession(mdFullPath)!;
        codeBlocks.forEach((block) => {
            const blockId = `block-${block.position}`;
            if (!currSession.codeBlocks.has(blockId)) {
                currSession.codeBlocks.set(blockId, {
                    ...block,
                    metadata: { status: 'pending', timestamp: Date.now() },
                    outputs: []
                });
            }
        });

        vscode.window.showInformationMessage('Previous session state loaded.');
    } else {
        // Create a fresh session
        const blockMap = new Map<string, CodeBlockExecution>();
        codeBlocks.forEach((block) => {
            const blockId = `block-${block.position}`;
            blockMap.set(blockId, {
                ...block,
                metadata: {
                    status: 'pending',
                    timestamp: Date.now(),
                },
                outputs: []
            });
        });

        const newState = {
            codeBlocks: blockMap,
            currentBlockIndex: 0,
            runCount: 0
        };
        stateManager.setSession(mdFullPath, newState);
        vscode.window.showInformationMessage('New session started!');
    }

    updatePanel(mdFullPath);
}

async function runBlockHandler(context: vscode.ExtensionContext, range: vscode.Range) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        return;
    }

    const docPath = getDocPath(editor);
    if (!docPath) {
        vscode.window.showErrorMessage('Please open a Markdown file first.');
        return;
    }

    // Make sure user has started a session for this file
    const stateManager = StateManager.getInstance();
    if (!stateManager.hasSession(docPath)) {
        // Approach B: Show error if no session
        vscode.window.showErrorMessage(`No active Drafty session for: ${path.basename(docPath)}. 
Please run "Drafty: Start Session" first.`);
        return;
    }

    // Extract code from the selected range
    let code = editor.document.getText(range);
    code = code.replace(/^```[\w\-]*\s*|```$/gm, '');

    // Figure out the fence's info (language)
    const text = editor.document.getText();
    const md = new MarkdownIt();
    const tokens = md.parse(text, {});
    let env: string | undefined;
    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.type === 'fence' && t.map) {
            const [startLine, endLine] = t.map;
            if (startLine === range.start.line && endLine === range.end.line + 1) {
                env = t.info.trim();
                break;
            }
        }
    }
    if (!env) {
        env = '';
    }

    await runSingleCodeBlock(context, docPath, code, range.start.line, env);
}

async function runSingleCodeBlock(
    context: vscode.ExtensionContext, 
    docPath: string, 
    code: string, 
    position: number, 
    language: string
) {
    const webviewManager = WebviewManager.getInstance();
    const envManager = EnvironmentManager.getInstance();
    const stateManager = StateManager.getInstance();

    // Ensure panel is open or reveal it
    await webviewManager.ensurePanel(context, docPath, handleWebviewMessage, panelDisposedCallback);
    webviewManager.revealPanel(docPath);

    // Retrieve the existing session for this doc
    const currentState = stateManager.getSession(docPath);
    if (!currentState) {
        // This theoretically shouldn't happen, because we checked in runBlockHandler,
        // but just in case:
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
            status: 'running',
            timestamp: Date.now(),
            runNumber,
        },
        outputs: []
    };

    // Place or replace in the map
    currentState.codeBlocks.set(blockId, blockExecution);
    updatePanel(docPath);

    // Ask webview to scroll to this block
    const panel = webviewManager.getPanel(docPath);
    panel?.webview.postMessage({
        command: 'scrollToBlock',
        blockId
    });

    // Runner
    const runner = languageRunners.get(language.toLowerCase());
    if (!runner) {
        blockExecution.metadata.status = 'error';
        blockExecution.outputs = [{
            type: 'error',
            timestamp: Date.now(),
            error: `No runner available for language: ${language}`,
            traceback: []
        }];
        updatePanel(docPath);
        return;
    }

    const onPartialOutput = (partialOutput: CellOutput) => {
        const currSession = stateManager.getSession(docPath);
        if (!currSession) return;

        const block = currSession.codeBlocks.get(blockId);
        if (!block) return;

        if (partialOutput.type === 'image') {
            // Overwrite old images from same run
            const oldImageIndex = block.outputs.findIndex(o => o.type === 'image');
            if (oldImageIndex !== -1) {
                block.outputs[oldImageIndex] = partialOutput;
            } else {
                block.outputs.push(partialOutput);
            }
        } else {
            block.outputs.push(partialOutput);
        }

        panel?.webview.postMessage({
            command: 'partialOutput',
            blockId,
            output: partialOutput
        });
    };

    const { process, promise } = runner.executeCode(
        docPath,
        code,
        envManager.getSelectedPath(),
        blockId,
        onPartialOutput
    );
    runningProcesses.set(blockId, process);

    try {
        await promise;
        blockExecution.metadata.status = 'success';
    } catch (error) {
        const errStr = error instanceof Error ? error.message : String(error);
        blockExecution.outputs = [
            {
                type: 'error',
                timestamp: Date.now(),
                error: errStr,
                traceback: []
            }
        ];
        blockExecution.metadata.status = 'error';
    } finally {
        runningProcesses.delete(blockId);
    }

    blockExecution.metadata.executionTime = Date.now() - blockExecution.metadata.timestamp;
    updatePanel(docPath);
}

function terminateBlockHandler(context: vscode.ExtensionContext, range: vscode.Range) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        return;
    }

    const docPath = getDocPath(editor);
    if (!docPath) {
        vscode.window.showErrorMessage('Please open a Markdown file first.');
        return;
    }

    const stateManager = StateManager.getInstance();
    if (!stateManager.hasSession(docPath)) {
        vscode.window.showErrorMessage(`No active session for file: ${path.basename(docPath)}. 
Please run "Drafty: Start Session" first.`);
        return;
    }

    const currentState = stateManager.getSession(docPath);
    if (!currentState) {
        vscode.window.showErrorMessage(`No session found for file: ${docPath}`);
        return;
    }

    const blockId = `block-${range.start.line}`;
    if (!runningProcesses.has(blockId)) {
        vscode.window.showInformationMessage('No running process found for this block.');
        return;
    }

    try {
        const processToKill = runningProcesses.get(blockId);
        processToKill?.kill?.();
        runningProcesses.delete(blockId);

        const blockExecution = currentState.codeBlocks.get(blockId);
        if (blockExecution) {
            blockExecution.metadata.status = 'error';
            blockExecution.outputs.push({
                type: 'text',
                timestamp: Date.now(),
                content: 'Execution terminated by user.',
                stream: 'stderr'
            });
        }

        updatePanel(docPath);
        vscode.window.showInformationMessage(`Terminated execution of block at line ${range.start.line}.`);
    } catch (err) {
        vscode.window.showErrorMessage(`Failed to terminate block: ${String(err)}`);
    }
}

/**
 * Called when user clicks "Save Results" in the webview.
 * We do Approach B: If there's no session for that doc, we show an error.
 */
function handleSaveState(mdFullPath: string) {
    const stateManager = StateManager.getInstance();
    if (!stateManager.hasSession(mdFullPath)) {
        vscode.window.showErrorMessage(`No active session for file: ${path.basename(mdFullPath)}. 
Please run "Drafty: Start Session" first.`);
        return;
    }

    const session = stateManager.getSession(mdFullPath);
    if (!session) {
        vscode.window.showErrorMessage(`No session found for file: ${mdFullPath}`);
        return;
    }

    try {
        const savePath = stateManager.saveSession(mdFullPath, session);
        vscode.window.showInformationMessage(`Results saved to: ${savePath}`);
    } catch (err) {
        vscode.window.showErrorMessage(`Failed to save results: ${String(err)}`);
    }
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
        envManager.getSelectedPath()
    );
}

function extractCodeBlocks(tokens: any[]): CodeBlock[] {
    const blocks: CodeBlock[] = [];
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (token.type === 'fence' && token.map) {
            blocks.push({
                content: token.content,
                info: token.info.trim(),
                position: token.map[0]
            });
        }
    }
    return blocks;
}

class MarkdownCodeLensProvider implements vscode.CodeLensProvider {
    public provideCodeLenses(
        document: vscode.TextDocument,
        token: vscode.CancellationToken
    ): vscode.CodeLens[] {
        const codeLenses: vscode.CodeLens[] = [];
        const text = document.getText();
        const md = new MarkdownIt();
        const tokens = md.parse(text, {});

        for (let i = 0; i < tokens.length; i++) {
            const token = tokens[i];
            if (token.type === 'fence' && token.map) {
                const [startLine, endLine] = token.map; // endLine is exclusive
                const range = new vscode.Range(startLine, 0, endLine - 1, 0);

                // 1) Run code block
                const runCmd: vscode.Command = {
                    title: '▶ Run Code Block',
                    command: 'drafty.runBlock',
                    arguments: [range]
                };
                codeLenses.push(new vscode.CodeLens(range, runCmd));

                // 2) Terminate code block
                const termCmd: vscode.Command = {
                    title: '✖ Terminate Execution',
                    command: 'drafty.terminateBlock',
                    arguments: [range]
                };
                codeLenses.push(new vscode.CodeLens(range, termCmd));
            }
        }
        return codeLenses;
    }
}

export function deactivate() {
    const stateManager = StateManager.getInstance();
    stateManager.clearAllSessions();

    const webviewManager = WebviewManager.getInstance();
    webviewManager.disposeAllPanels();

    // remove *all* runners from pythonAdapter:
    const pythonAdapter = languageRunners.get('python');
    // We can define a helper method in the adapter:
    if (pythonAdapter && 'disposeAll' in pythonAdapter) {
        (pythonAdapter as any).disposeAll();
    }
    
    console.log('Drafty extension deactivated');
}
