import * as vscode from 'vscode';
import * as MarkdownIt from 'markdown-it';
import { exec } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { PythonRunner } from './pythonRunner';
import { CellOutput, CodeBlock, CodeBlockExecution } from './types';

// ---------------------------------------------
// Global/Session State
// ---------------------------------------------
let currentPanel: vscode.WebviewPanel | undefined;
let nodeGlobalState: { [key: string]: any } = {};

interface SessionState {
    codeBlocks: Map<string, CodeBlockExecution>;
    currentBlockIndex: number;
}
let sessionState: SessionState | undefined = undefined;

let selectedEnvironment: 'python' | 'node' | undefined = undefined;
// The Python interpreter path to use when running Python code.
let selectedPythonPath: string = 'python3';

// Our dynamically discovered Python environments (for the dropdown)
let discoveredEnvironments: { label: string; path: string }[] = [];

// ---------------------------------------------
// Node.js Execution
// ---------------------------------------------
async function executeNodeCode(code: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        try {
            // Inject global state
            const stateInjection = Object.entries(nodeGlobalState)
                .map(([key, value]) => `let ${key} = ${JSON.stringify(value)};`)
                .join('\n');

            const fullCode = `${stateInjection}\n${code}\n`;
            const result = eval(fullCode);

            // Attempt to gather updated global state
            const context = eval(`(${fullCode})\n(() => ({ ...global }))()`);
            nodeGlobalState = { ...nodeGlobalState, ...context };

            resolve(String(result));
        } catch (error) {
            reject(error);
        }
    });
}

// ---------------------------------------------
// Extension entry points
// ---------------------------------------------
export function activate(context: vscode.ExtensionContext) {
    console.log('Markdown Code Runner is now active');

    const runNextBlockCmd = vscode.commands.registerCommand('mdrun.runNextBlock', runNextBlockHandler);
    const startSessionCmd = vscode.commands.registerCommand('mdrun.startSession', startSessionHandler);
    const runBlockCmd = vscode.commands.registerCommand('mdrun.runBlock', runBlockHandler);

    // Register commands and CodeLens provider
    context.subscriptions.push(runNextBlockCmd, startSessionCmd, runBlockCmd);
    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider('markdown', new MarkdownCodeLensProvider())
    );
}

async function runNextBlockHandler() {
    if (!sessionState) {
        vscode.window.showErrorMessage('No active code execution session');
        return;
    }

    const blockCount = sessionState.codeBlocks.size;
    if (sessionState.currentBlockIndex >= blockCount) {
        vscode.window.showInformationMessage('All code blocks executed');
        return;
    }

    const blockId = `block-${sessionState.currentBlockIndex}`;
    const currentBlock = sessionState.codeBlocks.get(blockId);
    if (!currentBlock) {
        return;
    }

    // Update block metadata to running state
    currentBlock.metadata = {
        status: 'running',
        timestamp: Date.now()
    };

    try {
        if (selectedEnvironment === 'python') {
            const outputs = await PythonRunner.getInstance().executeCode(currentBlock.content, selectedPythonPath);
            currentBlock.outputs = outputs;
            currentBlock.metadata.status = 'success';
        } else if (selectedEnvironment === 'node') {
            const result = await executeNodeCode(currentBlock.content);
            currentBlock.outputs = [{
                type: 'text',
                timestamp: Date.now(),
                content: result,
                stream: 'stdout'
            }];
            currentBlock.metadata.status = 'success';
        }
    } catch (error) {
        const errStr = error instanceof Error ? error.message : String(error);
        currentBlock.outputs = [{
            type: 'error',
            timestamp: Date.now(),
            error: errStr,
            traceback: []
        }];
        currentBlock.metadata.status = 'error';
    }

    currentBlock.metadata.executionTime = Date.now() - currentBlock.metadata.timestamp;
    sessionState.codeBlocks.set(blockId, currentBlock);
    updatePanel();
    sessionState.currentBlockIndex++;
}

async function startSessionHandler() {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'markdown') {
        vscode.window.showErrorMessage('Please open a Markdown file first');
        return;
    }

    // Prompt: python or node?
    if (!selectedEnvironment) {
        const pick = await vscode.window.showQuickPick(['python', 'node'], {
            placeHolder: 'Select execution environment'
        });
        if (!pick) {
            return;
        }
        selectedEnvironment = pick as 'python' | 'node';
    }

    // If user picks python, gather available environments
    if (selectedEnvironment === 'python') {
        discoveredEnvironments = await gatherPythonEnvironments();
        // If we found any envs, let's default to the first, or fallback to "python3"
        if (discoveredEnvironments.length > 0) {
            selectedPythonPath = discoveredEnvironments[0].path;
        }
    }

    // Create and show the webview if not open
    if (!currentPanel) {
        currentPanel = vscode.window.createWebviewPanel(
            'codeResults',
            'Code Execution Results',
            vscode.ViewColumn.Beside,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        // Listen for messages (e.g. environment changes)
        currentPanel.webview.onDidReceiveMessage((message) => {
            if (message.command === 'changeEnv') {
                selectedPythonPath = message.pythonPath;
                vscode.window.showInformationMessage(`Switched to: ${selectedPythonPath}`);
            }
        });

        // Cleanup
        currentPanel.onDidDispose(() => {
            currentPanel = undefined;
            nodeGlobalState = {};
            selectedEnvironment = undefined;
            sessionState = undefined;
            PythonRunner.getInstance().clearState();
        });
    }

    // Parse out code blocks from the markdown
    const markdown = editor.document.getText();
    const md = new MarkdownIt();
    const tokens = md.parse(markdown, {});
    const codeBlocks = extractCodeBlocks(tokens);

    // Initialize session with a Map to track block executions
    const blockMap = new Map<string, CodeBlockExecution>();
    codeBlocks.forEach((block, index) => {
        const blockId = `block-${index}`;
        blockMap.set(blockId, {
            ...block,
            metadata: {
                status: 'pending',
                timestamp: Date.now()
            },
            outputs: []
        });
    });

    sessionState = {
        codeBlocks: blockMap,
        currentBlockIndex: 0
    };

    updatePanel();
    vscode.window.showInformationMessage('Session started! Use "Run Next Block" or CodeLens to run code.');
}

async function runBlockHandler(range: vscode.Range) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        return;
    }
    let code = editor.document.getText(range);
    // Remove the Markdown fence lines:
    code = code.replace(/^```[\w\-]*\s*|```$/gm, '');
    await runSingleCodeBlock(code);
}

// Run a single code block
async function runSingleCodeBlock(code: string) {
    // If no panel, open it
    if (!currentPanel) {
        currentPanel = vscode.window.createWebviewPanel(
            'codeResults',
            'Code Execution Results',
            vscode.ViewColumn.Beside,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );
        // Same event listener
        currentPanel.webview.onDidReceiveMessage((message) => {
            if (message.command === 'changeEnv') {
                selectedPythonPath = message.pythonPath;
                vscode.window.showInformationMessage(`Switched to: ${selectedPythonPath}`);
            }
        });
        currentPanel.onDidDispose(() => {
            currentPanel = undefined;
            nodeGlobalState = {};
            selectedEnvironment = undefined;
            sessionState = undefined;
            PythonRunner.getInstance().clearState();
        });
    }

    // If no environment chosen, ask
    if (!selectedEnvironment) {
        const pick = await vscode.window.showQuickPick(['python', 'node'], {
            placeHolder: 'Select execution environment'
        });
        if (!pick) {
            return;
        }
        selectedEnvironment = pick as 'python' | 'node';

        if (selectedEnvironment === 'python') {
            discoveredEnvironments = await gatherPythonEnvironments();
            if (discoveredEnvironments.length > 0) {
                selectedPythonPath = discoveredEnvironments[0].path;
            }
        }
    }

    // Create or get block execution
    const blockId = !sessionState ? 'single-block' : `block-${sessionState.currentBlockIndex}`;
    const blockExecution: CodeBlockExecution = {
        content: code,
        info: selectedEnvironment || '',
        metadata: {
            status: 'running',
            timestamp: Date.now()
        },
        outputs: []
    };

    try {
        if (selectedEnvironment === 'python') {
            blockExecution.outputs = await PythonRunner.getInstance().executeCode(code, selectedPythonPath);
        } else {
            const result = await executeNodeCode(code);
            blockExecution.outputs = [{
                type: 'text',
                timestamp: Date.now(),
                content: result,
                stream: 'stdout'
            }];
        }
        blockExecution.metadata.status = 'success';
    } catch (error) {
        const errStr = error instanceof Error ? error.message : String(error);
        blockExecution.outputs = [{
            type: 'error',
            timestamp: Date.now(),
            error: errStr,
            traceback: []
        }];
        blockExecution.metadata.status = 'error';
    }

    blockExecution.metadata.executionTime = Date.now() - blockExecution.metadata.timestamp;

    // Update session state if it exists
    if (sessionState) {
        sessionState.codeBlocks.set(blockId, blockExecution);
        updatePanel();
    } else {
        // Create a temporary map for single block execution
        const tempMap = new Map<string, CodeBlockExecution>();
        tempMap.set(blockId, blockExecution);
        updatePanel(tempMap);
    }
}

// ---------------------------------------------
// Gather python environments via conda + .virtualenvs
// ---------------------------------------------
async function gatherPythonEnvironments(): Promise<{ label: string; path: string }[]> {
    const results: { label: string; path: string }[] = [];

    // 1) Gather from conda env list
    const condaEnvs = await listCondaEnvs();
    results.push(...condaEnvs);

    // 2) Gather from ~/.virtualenvs
    const venvs = listVirtualenvs();
    results.push(...venvs);

    // If none found, fallback to "python3"
    if (results.length === 0) {
        results.push({
            label: 'Default: python3',
            path: 'python3'
        });
    }
    return results;
}

function listVirtualenvs(): { label: string; path: string }[] {
    const homeDir = os.homedir();
    const venvFolder = path.join(homeDir, '.virtualenvs');
    const out: { label: string; path: string }[] = [];

    if (fs.existsSync(venvFolder) && fs.statSync(venvFolder).isDirectory()) {
        const subdirs = fs.readdirSync(venvFolder, { withFileTypes: true });
        for (const d of subdirs) {
            if (d.isDirectory()) {
                const envName = d.name;
                // On Unix-like systems, the python executable is usually in <env>/bin/python
                const pyPath = path.join(venvFolder, envName, 'bin', 'python');
                if (fs.existsSync(pyPath)) {
                    out.push({
                        label: `venv: ${envName}`,
                        path: pyPath
                    });
                }
            }
        }
    }
    return out;
}

function listCondaEnvs(): Promise<{ label: string; path: string }[]> {
    return new Promise((resolve) => {
        
        const cmd = `source ~/.zshrc && conda env list --json`;

        exec(cmd, { shell: '/bin/zsh' }, (error, stdout, stderr) => {
            if (error) {
                console.error('Could not run conda env list:', error);
                return resolve([]);
            }
            try {
                const data = JSON.parse(stdout);
                if (Array.isArray(data.envs)) {
                    // data.envs is an array of absolute paths to each env
                    // e.g. "/Users/you/miniconda3/envs/myenv"
                    const results: { label: string; path: string }[] = [];
                    for (const envPath of data.envs) {
                        // We'll parse the env name from the folder name
                        // e.g. "myenv" from ".../envs/myenv"
                        const envName = path.basename(envPath);
                        const label = `conda: ${envName}`;

                        // On Unix, the python binary is typically at <envPath>/bin/python
                        // If it doesn't exist, maybe we're on Windows, so fallback to something else.
                        const pyBin = path.join(envPath, 'bin', 'python');
                        if (fs.existsSync(pyBin)) {
                            results.push({ label, path: pyBin });
                        } else {
                            // On Windows, it might be <envPath>\\python.exe
                            const winBin = path.join(envPath, 'python.exe');
                            if (fs.existsSync(winBin)) {
                                results.push({ label, path: winBin });
                            } else {
                                // Fallback if we can't detect the binary
                                results.push({ label, path: envPath });
                            }
                        }
                    }
                    return resolve(results);
                }
            } catch (parseErr) {
                console.error('Failed to parse conda --json output:', parseErr);
            }
            return resolve([]);
        });
    });
}


// ---------------------------------------------
// Extract code blocks for chosen environment
// ---------------------------------------------
function extractCodeBlocks(tokens: any[]): CodeBlock[] {
    const blocks: CodeBlock[] = [];
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (
            token.type === 'fence' &&
            (token.info === selectedEnvironment || token.info === '')
        ) {
            blocks.push({
                content: token.content,
                info: token.info
            });
        }
    }
    return blocks;
}

// ---------------------------------------------
// Update the Webview
// ---------------------------------------------
function updatePanel(blockMap?: Map<string, CodeBlockExecution>) {
    if (!currentPanel) {
        return;
    }
    const blocks = blockMap || (sessionState?.codeBlocks || new Map());
    currentPanel.webview.html = getWebviewContent(blocks);
}

function getWebviewContent(blocks: Map<string, CodeBlockExecution>): string {
    // Build <option> tags from discoveredEnvironments
    const optionsHtml = discoveredEnvironments
        .map((env) => {
            const selectedAttr = env.path === selectedPythonPath ? 'selected' : '';
            return `<option value="${env.path}" ${selectedAttr}>${env.label}</option>`;
        })
        .join('');

    const outputHtml = Array.from(blocks.values())
        .map((block) => {
            const statusClass = `status-${block.metadata.status}`;
            const executionTime = block.metadata.executionTime 
                ? `(${(block.metadata.executionTime / 1000).toFixed(2)}s)` 
                : '';
            
            const outputsHtml = block.outputs
                .map((output) => {
                    switch (output.type) {
                        case 'text':
                            return `
                                <div class="output text-output ${output.stream}">
                                    ${escapeHtml(output.content)}
                                </div>`;
                        case 'image':
                            return `
                                <div class="output image-output">
                                    <img src="data:image/${output.format};base64,${output.data}" 
                                         alt="Output visualization" />
                                </div>`;
                        case 'error':
                            return `
                                <div class="output error-output">
                                    <div class="error-message">${escapeHtml(output.error)}</div>
                                </div>`;
                        case 'rich':
                            return `
                                <div class="output rich-output">
                                    ${output.format === 'html' ? output.content : escapeHtml(output.content)}
                                </div>`;
                        default:
                            return '';
                    }
                })
                .join('\n');

            return `
                <div class="block-container ${statusClass}">
                    <div class="block-header">
                        <span class="status">${block.metadata.status}</span>
                        <span class="time">${executionTime}</span>
                    </div>
                    <div class="block-outputs">
                        ${outputsHtml}
                    </div>
                </div>`;
        })
        .join('\n');

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <title>Code Execution Results</title>
    <style>
        body {
            padding: 20px;
            font-family: var(--vscode-editor-font-family);
            line-height: 1.5;
            color: var(--vscode-editor-foreground);
            background-color: var(--vscode-editor-background);
        }
        .env-picker {
            margin-bottom: 1em;
        }
        .block-container {
            margin-bottom: 20px;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            overflow: hidden;
        }
        .block-header {
            padding: 5px 10px;
            background: var(--vscode-editor-lineHighlightBackground);
            border-bottom: 1px solid var(--vscode-panel-border);
            display: flex;
            justify-content: space-between;
        }
        .block-header .status {
            text-transform: capitalize;
        }
        .block-header .time {
            color: var(--vscode-descriptionForeground);
        }
        .block-outputs {
            padding: 10px;
        }
        .output {
            margin-bottom: 10px;
        }
        .text-output {
            white-space: pre-wrap;
            font-family: var(--vscode-editor-font-family);
        }
        .text-output.stderr {
            color: var(--vscode-errorForeground);
            background-color: var(--vscode-inputValidation-errorBackground);
        }
        .image-output {
            text-align: center;
        }
        .image-output img {
            max-width: 100%;
            height: auto;
        }
        .error-output {
            color: var(--vscode-errorForeground);
            border: 1px solid var(--vscode-inputValidation-errorBorder);
            padding: 10px;
            border-radius: 4px;
        }
        .rich-output {
            background-color: var(--vscode-editor-background);
        }
        .status-running {
            border-color: var(--vscode-progressBar-background);
        }
        .status-success {
            border-color: var(--vscode-testing-iconPassed);
        }
        .status-error {
            border-color: var(--vscode-testing-iconFailed);
        }
    </style>
</head>
<body>
    <div class="env-picker">
        ${
            selectedEnvironment === 'python'
                ? `
                    <label for="envSelect"><strong>Python Interpreter:</strong></label>
                    <select id="envSelect">${optionsHtml}</select>
                `
                : ''
        }
    </div>

    ${outputHtml}

    <script>
        const vscode = acquireVsCodeApi();
        const envSelect = document.getElementById('envSelect');
        if (envSelect) {
            envSelect.addEventListener('change', (event) => {
                vscode.postMessage({
                    command: 'changeEnv',
                    pythonPath: event.target.value
                });
            });
        }
    </script>
</body>
</html>`;
}

function escapeHtml(unsafe: string): string {
    return unsafe
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// ---------------------------------------------
// Deactivate
// ---------------------------------------------
export function deactivate() {
    nodeGlobalState = {};
    selectedEnvironment = undefined;
    sessionState = undefined;
    if (currentPanel) {
        currentPanel.dispose();
    }
    PythonRunner.getInstance().clearState();
}

// ---------------------------------------------
// CodeLens: "Run Code Block"
// ---------------------------------------------
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
                const cmd: vscode.Command = {
                    title: '▶ Run Code Block',
                    command: 'mdrun.runBlock',
                    arguments: [range]
                };
                codeLenses.push(new vscode.CodeLens(range, cmd));
            }
        }
        return codeLenses;
    }
}
