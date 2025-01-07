//////////////////// <extension.ts> ////////////////////
import * as vscode from 'vscode';
import * as MarkdownIt from 'markdown-it';
import { exec } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { PythonRunner } from './pythonRunner';
import { CodeBlock, CodeBlockExecution, CellOutput } from './types';

// ---------------------------------------------
// Global/Session State
// ---------------------------------------------
let currentPanel: vscode.WebviewPanel | undefined;
let nodeGlobalState: { [key: string]: any } = {};

interface SessionState {
    codeBlocks: Map<string, CodeBlockExecution>;
    currentBlockIndex: number;
    runCount: number;
}
let sessionState: SessionState | undefined = undefined;

let selectedPythonPath: string = 'python3';
let discoveredEnvironments: { label: string; path: string }[] = [];

// Keep track of running processes to allow termination.
const runningProcesses: Map<string, any> = new Map();

// ---------------------------------------------
// Extension entry points
// ---------------------------------------------
export function activate(context: vscode.ExtensionContext) {
    console.log('Markdown Code Runner is now active');

    const startSessionCmd = vscode.commands.registerCommand('mdrun.startSession', startSessionHandler);
    const runBlockCmd = vscode.commands.registerCommand('mdrun.runBlock', runBlockHandler);
    const terminateBlockCmd = vscode.commands.registerCommand('mdrun.terminateBlock', terminateBlockHandler);

    // Register commands and CodeLens provider
    context.subscriptions.push(startSessionCmd, runBlockCmd, terminateBlockCmd);
    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider('markdown', new MarkdownCodeLensProvider())
    );
}

async function ensurePanelAndEnvs() {
    // If the panel doesn't exist, create it & set up environment discovery
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

        // Gather Python environments
        discoveredEnvironments = await gatherPythonEnvironments();
        if (discoveredEnvironments.length > 0) {
            selectedPythonPath = discoveredEnvironments[0].path;
        }

        // Set up message listener, dispose handler, etc.:
        currentPanel.webview.onDidReceiveMessage((message) => {
            if (message.command === 'changeEnv') {
                selectedPythonPath = message.pythonPath;
                vscode.window.showInformationMessage(`Switched to: ${selectedPythonPath}`);
            }
        });

        currentPanel.onDidDispose(() => {
            currentPanel = undefined;
            nodeGlobalState = {};
            sessionState = undefined;
            PythonRunner.getInstance().clearState();
            runningProcesses.clear();
        });
    }
}

// ---------------------------------------------
// Start session: parse code blocks & detect environment from fence
// ---------------------------------------------
async function startSessionHandler() {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'markdown') {
        vscode.window.showErrorMessage('Please open a Markdown file first');
        return;
    }

    await ensurePanelAndEnvs();

    // Parse out code blocks from the markdown
    const markdown = editor.document.getText();
    const md = new MarkdownIt();
    const tokens = md.parse(markdown, {});
    const codeBlocks = extractCodeBlocks(tokens);

    // Initialize session with a Map to track block executions
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

    sessionState = {
        codeBlocks: blockMap,
        currentBlockIndex: 0,
        runCount: 0
    };

    updatePanel();
    vscode.window.showInformationMessage('Session started! Use "Run Code Block" or CodeLens to run code.');
}

// ---------------------------------------------
// Run a block
// ---------------------------------------------
async function runBlockHandler(range: vscode.Range) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        return;
    }
    let code = editor.document.getText(range);
    // Remove the Markdown fence lines:
    code = code.replace(/^```[\w\-]*\s*|```$/gm, '');

    // Look up the fence info (the environment) ourselves
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

    await runSingleCodeBlock(code, range.start.line, env);
}

// ---------------------------------------------
// Run a single code block (with streaming)
// ---------------------------------------------
async function runSingleCodeBlock(code: string, position: number, env: string) {
    await ensurePanelAndEnvs();

    // Generate a block ID
    const blockId = `block-${position}`;

    // If we have a session, increment runCount
    let runNumber = 1;
    if (sessionState) {
        sessionState.runCount++;
        runNumber = sessionState.runCount;
    }

    // Create (or replace) a CodeBlockExecution object
    const blockExecution: CodeBlockExecution = {
        content: code,
        info: env,
        position,
        metadata: {
            status: 'running',
            timestamp: Date.now(),
            runNumber: runNumber,
        },
        outputs: []
    };

    // If no session, create one
    if (!sessionState) {
        sessionState = {
            codeBlocks: new Map(),
            currentBlockIndex: 0,
            runCount: 1,
        };
    }
    // Replace any previous execution for this block
    sessionState.codeBlocks.set(blockId, blockExecution);

    // Force a quick update so the panel shows a fresh block container
    updatePanel(); // This ensures the block's "container" is in the DOM

    // Handle partial streaming
    const onPartialOutput = (partialOutput: CellOutput) => {
        // 1) Store in session state
        const b = sessionState?.codeBlocks.get(blockId);
        if (!b) return;
        // If it's an image, replace any existing image in `b.outputs`
        if (partialOutput.type === 'image') {
            const oldImageIndex = b.outputs.findIndex(o => o.type === 'image');
            if (oldImageIndex !== -1) {
                // Overwrite the previously stored image
                b.outputs[oldImageIndex] = partialOutput;
            } else {
                // If none exists yet, just push
                b.outputs.push(partialOutput);
            }
        } else {
            // For text, error, etc., just append
            b.outputs.push(partialOutput);
        }


        // 2) Post a message to the webview to update *just* this block in real time
        currentPanel?.webview.postMessage({
            command: 'partialOutput',   
            blockId,                   
            output: partialOutput       
        });
    };

    // Actually run the code
    const { pyshell, promise } = PythonRunner.getInstance().executeCode(
        code,
        selectedPythonPath,
        blockId,
        onPartialOutput
    );
    runningProcesses.set(blockId, pyshell);

    try {
        const { outputs } = await promise;
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
        // Remove from running processes if needed
        runningProcesses.delete(blockId);
    }

    blockExecution.metadata.executionTime = Date.now() - blockExecution.metadata.timestamp;
    // Final re-render to show the "finished" state
    updatePanel();
}

// ---------------------------------------------
// Terminate a running block
// ---------------------------------------------
function terminateBlockHandler(range: vscode.Range) {
    if (!sessionState) {
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
        processToKill?.kill?.(); // Attempt to kill
        runningProcesses.delete(blockId);

        // Also mark it as error or cancelled
        const blockExecution = sessionState.codeBlocks.get(blockId);
        if (blockExecution) {
            blockExecution.metadata.status = 'error';
            blockExecution.outputs.push({
                type: 'text',
                timestamp: Date.now(),
                content: 'Execution terminated by user.',
                stream: 'stderr'
            });
        }

        updatePanel();  // Re-render to reflect cancellation
        vscode.window.showInformationMessage(`Terminated execution of block at line ${range.start.line}.`);
    } catch (err) {
        vscode.window.showErrorMessage(`Failed to terminate block: ${String(err)}`);
    }
}

// ---------------------------------------------
// Gather python environments
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
                    const results: { label: string; path: string }[] = [];
                    for (const envPath of data.envs) {
                        const envName = path.basename(envPath);
                        const label = `conda: ${envName}`;
                        const pyBin = path.join(envPath, 'bin', 'python');
                        if (fs.existsSync(pyBin)) {
                            results.push({ label, path: pyBin });
                        } else {
                            const winBin = path.join(envPath, 'python.exe');
                            if (fs.existsSync(winBin)) {
                                results.push({ label, path: winBin });
                            } else {
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
// Extract code blocks that are python/javascript
// ---------------------------------------------
function extractCodeBlocks(tokens: any[]): CodeBlock[] {
    const blocks: CodeBlock[] = [];
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (
            token.type === 'fence' &&
            (token.info.trim() === 'python' || token.info.trim() === 'javascript') &&
            token.map
        ) {
            blocks.push({
                content: token.content,
                info: token.info.trim(),
                position: token.map[0]
            });
        }
    }
    return blocks;
}

// ---------------------------------------------
// Update the Webview
// ---------------------------------------------
function updatePanel() {
    if (!currentPanel) {
        return;
    }
    const blocks = sessionState?.codeBlocks || new Map();
    currentPanel.webview.html = getWebviewContent(blocks);
}

// ---------------------------------------------
// Webview HTML
// ---------------------------------------------
function getWebviewContent(blocks: Map<string, CodeBlockExecution>): string {
    // Build <option> tags from discoveredEnvironments
    const optionsHtml = discoveredEnvironments
        .map((env) => {
            const selectedAttr = env.path === selectedPythonPath ? 'selected' : '';
            return `<option value="${env.path}" ${selectedAttr}>${env.label}</option>`;
        })
        .join('');

    // We only want to display blocks that have actually run or are running
    const renderedBlocks = Array.from(blocks.values())
        .filter((b) => b.metadata.status !== 'pending')
        .sort((a, b) => a.position - b.position);

    // Build each block’s HTML
    const outputHtml = renderedBlocks
        .map((block) => {
            const statusClass = `status-${block.metadata.status}`;
            const executionTime = block.metadata.executionTime
                ? `(${(block.metadata.executionTime / 1000).toFixed(2)}s)`
                : '';
            const runLabel = block.metadata.runNumber
                ? `Output [${block.metadata.runNumber}]`
                : 'Output [?]';

            // We'll give each block a unique container ID: "result-block-block-XX"
            // so we can dynamically append partial output for that block later.
            const blockContainerId = `result-block-${"block-" + block.position}`;

            // Pre-render existing outputs (in case of re-runs or finished states)
            const outputsHtml = block.outputs
                .map((output) => createOutputHtml(output))
                .join('\n');

            return `
                <div class="block-container ${statusClass}" 
                     id="${blockContainerId}">
                    <div class="block-header">
                        <span class="status">${runLabel}</span>
                        <span class="time">${executionTime}</span>
                    </div>
                    <div class="block-outputs">
                        ${outputsHtml}
                    </div>
                </div>`;
        })
        .join('\n');

    // Wrap everything in a minimal HTML doc
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <title>Code Execution Results</title>
    <style>
        /* your styles, same as before */
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
            text-align: left;
            font-family: var(--vscode-editor-font-family);
        }
        .text-output.stderr {
            color: var(--vscode-errorForeground);
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
        <label for="envSelect"><strong>Python Interpreter:</strong></label>
        <select id="envSelect">${optionsHtml}</select>
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

        // Listen for partial outputs from extension
        window.addEventListener('message', event => {
            const message = event.data;
            if (message.command === 'partialOutput') {
                const { blockId, output } = message;
                updateBlockOutput(blockId, output);
            }
        });

        // Dynamically update or append partial outputs for a running block
        function updateBlockOutput(blockId, output) {
            // Our container ID: "result-block-" + blockId
            const containerId = 'result-block-' + blockId;
            const blockContainer = document.getElementById(containerId);
            if (!blockContainer) {
                return; // The block container doesn't exist yet
            }
            const outputsDiv = blockContainer.querySelector('.block-outputs');
            if (!outputsDiv) {
                return;
            }

            if (output.type === 'text') {
                // Append a new line of text
                const textDiv = document.createElement('div');
                textDiv.classList.add('output', 'text-output');
                if (output.stream) {
                    textDiv.classList.add(output.stream);
                }
                textDiv.textContent = output.content;
                outputsDiv.appendChild(textDiv);

            } else if (output.type === 'image') {
                // Update or create a single <img> to represent the live plot
                // We'll wrap it in a .image-output if we want consistent styling
                let imgWrapper = outputsDiv.querySelector('.image-output');
                if (!imgWrapper) {
                    imgWrapper = document.createElement('div');
                    imgWrapper.classList.add('output', 'image-output');
                    outputsDiv.appendChild(imgWrapper);
                }
                let imgEl = imgWrapper.querySelector('img.live-plot');
                if (!imgEl) {
                    imgEl = document.createElement('img');
                    imgEl.classList.add('live-plot');
                    imgWrapper.appendChild(imgEl);
                }
                // Update the SRC with the new base64 data
                const format = output.format || 'png';
                imgEl.src = 'data:image/' + format + ';base64,' + output.data;

            } else if (output.type === 'error') {
                // Show an error line
                const errDiv = document.createElement('div');
                errDiv.classList.add('output', 'error-output');
                errDiv.textContent = output.error;
                outputsDiv.appendChild(errDiv);

            } else if (output.type === 'rich') {
                // Append a "rich" HTML snippet
                const richDiv = document.createElement('div');
                richDiv.classList.add('output', 'rich-output');
                if (output.format === 'html') {
                    richDiv.innerHTML = output.content;
                } else {
                    richDiv.textContent = output.content;
                }
                outputsDiv.appendChild(richDiv);
            }
        }
    </script>
</body>
</html>`;
}

// ---------------------------------------------
function createOutputHtml(output: CellOutput): string {
    switch (output.type) {
        case 'text':
            return `
                <div class="output text-output ${output.stream || ''}">
                    ${escapeHtml(output.content)}
                </div>`;
        case 'image':
            return `
                <div class="output image-output">
                    <img class="live-plot" src="data:image/${output.format || 'png'};base64,${output.data}" 
                         alt="Output visualization" />
                </div>`;
        case 'error':
            return `
                <div class="output error-output">
                    <div class="error-message">${escapeHtml(output.error)}</div>
                </div>`;
        case 'rich':
            if (output.format === 'html') {
                return `<div class="output rich-output">${output.content}</div>`;
            } else {
                return `<div class="output rich-output">${escapeHtml(output.content)}</div>`;
            }
        default:
            return '';
    }
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
export function deactivate() {
    nodeGlobalState = {};
    sessionState = undefined;
    if (currentPanel) {
        currentPanel.dispose();
    }
    PythonRunner.getInstance().clearState();
    runningProcesses.clear();
}

// ---------------------------------------------
// CodeLens: "Run Code Block" + "Terminate Execution"
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

                // 1) Run code block
                const runCmd: vscode.Command = {
                    title: '▶ Run Code Block',
                    command: 'mdrun.runBlock',
                    arguments: [range]
                };
                codeLenses.push(new vscode.CodeLens(range, runCmd));

                // 2) Terminate code block
                const termCmd: vscode.Command = {
                    title: '✖ Terminate Execution',
                    command: 'mdrun.terminateBlock',
                    arguments: [range]
                };
                codeLenses.push(new vscode.CodeLens(range, termCmd));
            }
        }
        return codeLenses;
    }
}
