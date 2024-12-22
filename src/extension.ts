//////////////////// <extension.ts> ////////////////////
import * as vscode from 'vscode';
import * as MarkdownIt from 'markdown-it';
import { exec } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { PythonRunner } from './pythonRunner';
import { CodeBlock, CodeBlockExecution } from './types';

// ---------------------------------------------
// Global/Session State
// ---------------------------------------------
let currentPanel: vscode.WebviewPanel | undefined;
let nodeGlobalState: { [key: string]: any } = {};

interface SessionState {
    codeBlocks: Map<string, CodeBlockExecution>;
    currentBlockIndex: number;
    runCount: number; // <-- Added
}
let sessionState: SessionState | undefined = undefined;

let selectedPythonPath: string = 'python3';
let discoveredEnvironments: { label: string; path: string }[] = [];

// Keep track of running processes to allow termination.  // <-- Added
// Key = blockId, Value = child process or something that can be killed
const runningProcesses: Map<string, any> = new Map();

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

    // New command to terminate execution  // <-- Added
    const terminateBlockCmd = vscode.commands.registerCommand('mdrun.terminateBlock', terminateBlockHandler);

    // Register commands and CodeLens provider
    context.subscriptions.push(runNextBlockCmd, startSessionCmd, runBlockCmd, terminateBlockCmd);
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

    // Get all blocks sorted by position
    const sortedBlocks = Array.from(sessionState.codeBlocks.values())
        .sort((a, b) => a.position - b.position);
    
    const currentBlock = sortedBlocks[sessionState.currentBlockIndex];
    if (!currentBlock) {
        return;
    }

    // Update block metadata to running state
    currentBlock.metadata = {
        ...currentBlock.metadata,
        status: 'running',
        timestamp: Date.now()
    };

    // Bump the runCount so we label "output [x]"   // <-- Added
    sessionState.runCount++;
    currentBlock.metadata.runNumber = sessionState.runCount;

    // Generate block ID based on position
    const blockId = `block-${currentBlock.position}`;

    // Attempt to run
    try {
        if (currentBlock.info === 'python') {
            // Run with Python
            const outputs = await PythonRunner.getInstance().executeCode(currentBlock.content, selectedPythonPath);
            currentBlock.outputs = outputs;
            currentBlock.metadata.status = 'success';
        } else if (currentBlock.info === 'javascript') {
            // Run with Node
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
    } finally {
        // If we stored a running process for this block, remove it
        runningProcesses.delete(blockId);
    }

    currentBlock.metadata.executionTime = Date.now() - currentBlock.metadata.timestamp;
    sessionState.codeBlocks.set(blockId, currentBlock);
    updatePanel();
    sessionState.currentBlockIndex++;

    // If we've executed all blocks, reset the index
    if (sessionState.currentBlockIndex >= sortedBlocks.length) {
        sessionState.currentBlockIndex = 0;
    }
}

// enture envs options are always there
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

    // look up the fence info (the environment) ourselves
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

    // If the environment is python/javscript, we pass it along. Otherwise fallback.
    if (!env) {
        env = ''; 
    }

    await runSingleCodeBlock(code, range.start.line, env);
}

// Run a single code block
async function runSingleCodeBlock(code: string, position: number, env: string) {
    
    await ensurePanelAndEnvs();

    // Create or get block execution
    const blockId = !sessionState ? 'single-block' : `block-${position}`;

    // If we have a session, increment the runCount
    let runNumber = 1;
    if (sessionState) {
        sessionState.runCount++;
        runNumber = sessionState.runCount;
    }

    const blockExecution: CodeBlockExecution = {
        content: code,
        info: env,
        position: position,
        metadata: {
            status: 'running',
            timestamp: Date.now(),
            runNumber: runNumber,  // <-- Added
        },
        outputs: []
    };

    // Attempt to run
    try {
        if (env === 'python') {
            blockExecution.outputs = await PythonRunner.getInstance().executeCode(code, selectedPythonPath);
            blockExecution.metadata.status = 'success';
        } else if (env === 'javascript') {
            const result = await executeNodeCode(code);
            blockExecution.outputs = [{
                type: 'text',
                timestamp: Date.now(),
                content: result,
                stream: 'stdout'
            }];
            blockExecution.metadata.status = 'success';
        } else {
            // Fallback or unknown fence type
            blockExecution.outputs = [{
                type: 'text',
                timestamp: Date.now(),
                content: `Unknown environment: "${env}". Skipped.`,
                stream: 'stderr'
            }];
            blockExecution.metadata.status = 'error';
        }
    } catch (error) {
        const errStr = error instanceof Error ? error.message : String(error);
        blockExecution.outputs = [{
            type: 'error',
            timestamp: Date.now(),
            error: errStr,
            traceback: []
        }];
        blockExecution.metadata.status = 'error';
    } finally {
        // Remove from running processes if needed
        runningProcesses.delete(blockId);
    }

    blockExecution.metadata.executionTime = Date.now() - blockExecution.metadata.timestamp;

    // Create session state if it doesn't exist
    if (!sessionState) {
        sessionState = {
            codeBlocks: new Map(),
            currentBlockIndex: 0,
            runCount: 1, // we used runNumber=1 above
        };
    }

    // Generate a unique block ID based on position
    const positionBlockId = `block-${position}`;
    sessionState.codeBlocks.set(positionBlockId, blockExecution);
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
        vscode.window.showInformationMessage(`Terminated execution of block at line ${range.start.line}.`);
    } catch (err) {
        vscode.window.showErrorMessage(`Failed to terminate block: ${String(err)}`);
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
// Extract code blocks that are either python or javascript
// ---------------------------------------------
function extractCodeBlocks(tokens: any[]): CodeBlock[] {
    const blocks: CodeBlock[] = [];
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (
            token.type === 'fence' &&
            // We only track recognized fences: "python" or "javascript" 
            // (Feel free to extend to e.g. "js", "node", etc.)
            (token.info.trim() === 'python' || token.info.trim() === 'javascript') &&
            token.map
        ) {
            blocks.push({
                content: token.content,
                info: token.info.trim(),
                position: token.map[0] // Start line of the code block
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

// ---------------------------------------------
// IMPORTANT: Now we show "output [x]" in the block header
// ---------------------------------------------
function getWebviewContent(blocks: Map<string, CodeBlockExecution>): string {
    // Build <option> tags from discoveredEnvironments
    const optionsHtml = discoveredEnvironments
        .map((env) => {
            const selectedAttr = env.path === selectedPythonPath ? 'selected' : '';
            return `<option value="${env.path}" ${selectedAttr}>${env.label}</option>`;
        })
        .join('');

    const outputHtml = Array.from(blocks.values())
        .sort((a, b) => a.position - b.position) // Sort blocks by position
        .map((block) => {
            const statusClass = `status-${block.metadata.status}`;
            const executionTime = block.metadata.executionTime 
                ? `(${(block.metadata.executionTime / 1000).toFixed(2)}s)` 
                : '';

            // Instead of status text like "success", we show "output [runNumber]"
            const runLabel = block.metadata.runNumber
                ? `Output [${block.metadata.runNumber}]`
                : 'Output [?]';

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
                                    ${
                                        output.format === 'html' 
                                            ? output.content 
                                            : escapeHtml(output.content)
                                    }
                                </div>`;
                        default:
                            return '';
                    }
                })
                .join('\n');

            return `
                <div class="block-container ${statusClass}">
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
            // We'll still show the Python environment picker if the user wants to switch interpreters
            `
            <label for="envSelect"><strong>Python Interpreter:</strong></label>
            <select id="envSelect">${optionsHtml}</select>
            `
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
    sessionState = undefined;
    if (currentPanel) {
        currentPanel.dispose();
    }
    PythonRunner.getInstance().clearState();
    runningProcesses.clear();
}

// ---------------------------------------------
// CodeLens: "Run Code Block" + "Terminate Execution"  // <-- Modified
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
