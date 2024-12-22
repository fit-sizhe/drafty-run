import * as vscode from 'vscode';
import * as MarkdownIt from 'markdown-it';
import { exec } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { PythonRunner } from './pythonRunner';
import { CellOutput, CodeBlock } from './types';

// ---------------------------------------------
// Global/Session State
// ---------------------------------------------
let currentPanel: vscode.WebviewPanel | undefined;
let nodeGlobalState: { [key: string]: any } = {};

interface SessionState {
    codeBlocks: CodeBlock[];
    currentBlockIndex: number;
    allOutputs: CellOutput[];
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

    if (sessionState.currentBlockIndex >= sessionState.codeBlocks.length) {
        vscode.window.showInformationMessage('All code blocks executed');
        return;
    }

    const currentBlock = sessionState.codeBlocks[sessionState.currentBlockIndex];
    try {
        if (selectedEnvironment === 'python') {
            const outputs = await PythonRunner.getInstance().executeCode(currentBlock.content, selectedPythonPath);
            sessionState.allOutputs.push(...outputs);
            updatePanel(sessionState.allOutputs);
        } else if (selectedEnvironment === 'node') {
            const result = await executeNodeCode(currentBlock.content);
            sessionState.allOutputs.push({
                type: 'text',
                timestamp: Date.now(),
                content: result,
                stream: 'stdout'
            });
            updatePanel(sessionState.allOutputs);
        }
    } catch (error) {
        const errStr = error instanceof Error ? error.message : String(error);
        sessionState.allOutputs.push({
            type: 'error',
            timestamp: Date.now(),
            error: errStr,
            traceback: []
        });
        updatePanel(sessionState.allOutputs);
    }

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

    // Initialize session
    sessionState = {
        codeBlocks,
        currentBlockIndex: 0,
        allOutputs: []
    };

    updatePanel([]);
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

    // Actually run
    try {
        let newOutputs: CellOutput[] = [];
        if (selectedEnvironment === 'python') {
            const outputs = await PythonRunner.getInstance().executeCode(code, selectedPythonPath);
            newOutputs = outputs;
        } else {
            const result = await executeNodeCode(code);
            newOutputs = [
                {
                    type: 'text',
                    timestamp: Date.now(),
                    content: result,
                    stream: 'stdout'
                }
            ];
        }

        if (!sessionState) {
            updatePanel(newOutputs);
        } else {
            sessionState.allOutputs.push(...newOutputs);
            updatePanel(sessionState.allOutputs);
        }
    } catch (error) {
        const errStr = error instanceof Error ? error.message : String(error);
        const errorOutput: CellOutput = {
            type: 'error',
            timestamp: Date.now(),
            error: errStr,
            traceback: []
        };
        if (!sessionState) {
            updatePanel([errorOutput]);
        } else {
            sessionState.allOutputs.push(errorOutput);
            updatePanel(sessionState.allOutputs);
        }
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
function updatePanel(outputs: CellOutput[]) {
    if (!currentPanel) {
        return;
    }
    currentPanel.webview.html = getWebviewContent(outputs);
}

function getWebviewContent(outputs: CellOutput[]): string {
    // Build <option> tags from discoveredEnvironments
    const optionsHtml = discoveredEnvironments
        .map((env) => {
            const selectedAttr = env.path === selectedPythonPath ? 'selected' : '';
            return `<option value="${env.path}" ${selectedAttr}>${env.label}</option>`;
        })
        .join('');

    const outputHtml = outputs
        .map((output) => {
            switch (output.type) {
                case 'text':
                    return `
                        <div class="output-container">
                            <div class="output text-output ${output.stream}">
                                ${escapeHtml(output.content)}
                            </div>
                        </div>`;
                case 'image':
                    return `
                        <div class="output-container">
                            <div class="output image-output">
                                <img src="data:image/${output.format};base64,${output.data}" 
                                     alt="Output visualization" />
                            </div>
                        </div>`;
                case 'error':
                    return `
                        <div class="output-container">
                            <div class="output error-output">
                                <div class="error-message">${escapeHtml(output.error)}</div>
                            </div>
                        </div>`;
                case 'rich':
                    return `
                        <div class="output-container">
                            <div class="output rich-output">
                                ${output.format === 'html' ? output.content : escapeHtml(output.content)}
                            </div>
                        </div>`;
                default:
                    return '';
            }
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
        .output-container {
            margin-bottom: 20px;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            overflow: hidden;
        }
        .output {
            padding: 10px;
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
