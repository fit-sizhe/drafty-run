import * as vscode from 'vscode';
import * as path from 'path';
import * as MarkdownIt from 'markdown-it';
import { CodeBlock, CodeBlockExecution, CellOutput } from './types';
import { PythonRunner } from './pythonRunner';
import { EnvironmentManager } from './env_setup';
import { StateManager } from './state_io';
import { WebviewManager } from './webview';

// Keep track of running processes to allow termination
const runningProcesses: Map<string, any> = new Map();

// Interface for language runners
export interface ILanguageRunner {
    executeCode(
        code: string,
        envPath: string,
        blockId: string,
        onPartialOutput?: (output: CellOutput) => void
    ): { 
        process: any;
        promise: Promise<{ outputs: CellOutput[] }>;
    };
    clearState(): void;
}

// Adapter to make PythonRunner match ILanguageRunner interface
class PythonRunnerAdapter implements ILanguageRunner {
    private runner: PythonRunner;

    constructor(runner: PythonRunner) {
        this.runner = runner;
    }

    executeCode(
        code: string,
        envPath: string,
        blockId: string,
        onPartialOutput?: (output: CellOutput) => void
    ): { 
        process: any;
        promise: Promise<{ outputs: CellOutput[] }>;
    } {
        const result = this.runner.executeCode(code, envPath, blockId, onPartialOutput);
        return {
            process: result.pyshell,
            promise: result.promise
        };
    }

    clearState(): void {
        this.runner.clearState();
    }
}

// Registry for language runners
const languageRunners = new Map<string, ILanguageRunner>();

// Register the Python runner by default
languageRunners.set('python', new PythonRunnerAdapter(PythonRunner.getInstance()));

export function activate(context: vscode.ExtensionContext) {
    console.log('Drafty is now active');

    const startSessionCmd = vscode.commands.registerCommand('drafty.startSession', () => startSessionHandler(context));
    const runBlockCmd = vscode.commands.registerCommand('drafty.runBlock', (range: vscode.Range) => runBlockHandler(context, range));
    const terminateBlockCmd = vscode.commands.registerCommand('drafty.terminateBlock', terminateBlockHandler);

    // Register commands and CodeLens provider
    context.subscriptions.push(startSessionCmd, runBlockCmd, terminateBlockCmd);
    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider('markdown', new MarkdownCodeLensProvider())
    );

    // Initialize managers
    WebviewManager.getInstance();
    EnvironmentManager.getInstance();
    StateManager.getInstance();
}

async function handleWebviewMessage(message: any) {
    const envManager = EnvironmentManager.getInstance();
    const webviewManager = WebviewManager.getInstance();
    const _stateManager = StateManager.getInstance();

    if (message.command === 'changeEnv') {
        envManager.setSelectedPath(message.pythonPath);
        vscode.window.showInformationMessage(`Switched to: ${message.pythonPath}`);
    } else if (message.command === 'changeMaxHeight') {
        webviewManager.setMaxResultHeight(message.value);
        updatePanel();
    } else if (message.command === 'saveState') {
        handleSaveState();
    }
}

async function startSessionHandler(context: vscode.ExtensionContext) {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'markdown') {
        vscode.window.showErrorMessage('Please open a Markdown file first');
        return;
    }

    const webviewManager = WebviewManager.getInstance();
    const envManager = EnvironmentManager.getInstance();
    const stateManager = StateManager.getInstance();

    // Initialize environment manager
    await envManager.initialize();

    // Create webview panel
    const mdFullPath = editor.document.uri.fsPath;
    const filename = path.basename(mdFullPath, '.md')
    const title = `${filename} Results`;
    await webviewManager.ensurePanel(context, handleWebviewMessage, title);

    // Attempt to load previous state
    const existingState = stateManager.tryLoadPreviousState(mdFullPath);

    // Parse code blocks
    const markdown = editor.document.getText();
    const md = new MarkdownIt();
    const tokens = md.parse(markdown, {});
    const codeBlocks = extractCodeBlocks(tokens);

    if (existingState) {
        stateManager.setCurrentState(existingState);
        // Add any new code blocks
        codeBlocks.forEach((block) => {
            const blockId = `block-${block.position}`;
            const currentState = stateManager.getCurrentState()!;
            if (!currentState.codeBlocks.has(blockId)) {
                currentState.codeBlocks.set(blockId, {
                    ...block,
                    metadata: { status: 'pending', timestamp: Date.now() },
                    outputs: []
                });
            }
        });
        vscode.window.showInformationMessage('Previous session state loaded.');
    } else {
        // Initialize new session
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

        stateManager.setCurrentState({
            codeBlocks: blockMap,
            currentBlockIndex: 0,
            runCount: 0
        });
        vscode.window.showInformationMessage('New session started!');
    }

    updatePanel();
}

async function runBlockHandler(context: vscode.ExtensionContext, range: vscode.Range) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        return;
    }

    const stateManager = StateManager.getInstance();
    if (!stateManager.getCurrentState()) {
        await startSessionHandler(context);
    }
    
    let code = editor.document.getText(range);
    code = code.replace(/^```[\w\-]*\s*|```$/gm, '');

    // Look up the fence info
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

    await runSingleCodeBlock(context, code, range.start.line, env);
}

async function runSingleCodeBlock(context: vscode.ExtensionContext, code: string, position: number, language: string) {
    const webviewManager = WebviewManager.getInstance();
    const envManager = EnvironmentManager.getInstance();
    const stateManager = StateManager.getInstance();

    await webviewManager.ensurePanel(context, handleWebviewMessage);

    const blockId = `block-${position}`;

    let runNumber = 1;
    const currentState = stateManager.getCurrentState();
    if (currentState) {
        currentState.runCount++;
        runNumber = currentState.runCount;
    }

    const blockExecution: CodeBlockExecution = {
        content: code,
        info: language,
        position,
        metadata: {
            status: 'running',
            timestamp: Date.now(),
            runNumber: runNumber,
        },
        outputs: []
    };

    if (!currentState) {
        stateManager.setCurrentState({
            codeBlocks: new Map(),
            currentBlockIndex: 0,
            runCount: 1,
        });
    }

    stateManager.getCurrentState()!.codeBlocks.set(blockId, blockExecution);
    updatePanel();

    const panel = webviewManager.getPanel();
    panel?.webview.postMessage({
        command: 'scrollToBlock',
        blockId
    });

    // Get the appropriate runner for the language
    const runner = languageRunners.get(language.toLowerCase());
    if (!runner) {
        blockExecution.metadata.status = 'error';
        blockExecution.outputs = [{
            type: 'error',
            timestamp: Date.now(),
            error: `No runner available for language: ${language}`,
            traceback: []
        }];
        updatePanel();
        return;
    }

    const onPartialOutput = (partialOutput: CellOutput) => {
        const state = stateManager.getCurrentState();
        const b = state?.codeBlocks.get(blockId);
        if (!b) return;

        if (partialOutput.type === 'image') {
            const oldImageIndex = b.outputs.findIndex(o => o.type === 'image');
            if (oldImageIndex !== -1) {
                b.outputs[oldImageIndex] = partialOutput;
            } else {
                b.outputs.push(partialOutput);
            }
        } else {
            b.outputs.push(partialOutput);
        }

        panel?.webview.postMessage({
            command: 'partialOutput',
            blockId,
            output: partialOutput
        });
    };

    const { process, promise } = runner.executeCode(
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
    updatePanel();
}

function terminateBlockHandler(range: vscode.Range) {
    const stateManager = StateManager.getInstance();
    const currentState = stateManager.getCurrentState();
    
    if (!currentState) {
        vscode.window.showErrorMessage('No session running to terminate a block.');
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

        updatePanel();
        vscode.window.showInformationMessage(`Terminated execution of block at line ${range.start.line}.`);
    } catch (err) {
        vscode.window.showErrorMessage(`Failed to terminate block: ${String(err)}`);
    }
}

function handleSaveState() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const stateManager = StateManager.getInstance();
    try {
        const savePath = stateManager.saveCurrentState(editor.document.uri.fsPath);
        vscode.window.showInformationMessage(`Results saved to: ${savePath}`);
    } catch (err) {
        vscode.window.showErrorMessage(`Failed to save results: ${String(err)}`);
    }
}

function updatePanel() {
    const webviewManager = WebviewManager.getInstance();
    const envManager = EnvironmentManager.getInstance();
    const stateManager = StateManager.getInstance();

    const currentState = stateManager.getCurrentState();
    if (!currentState) return;

    webviewManager.updateContent(
        currentState.codeBlocks,
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
    const webviewManager = WebviewManager.getInstance();
    
    stateManager.clearState();
    const panel = webviewManager.getPanel();
    if (panel) {
        panel.dispose();
    }
    
    // Clear all runners
    for (const runner of languageRunners.values()) {
        runner.clearState();
    }
    runningProcesses.clear();
}
