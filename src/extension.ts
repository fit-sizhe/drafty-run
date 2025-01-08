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
let maxResultHeight = 400; // default max height for blocks in px

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
    console.log('Drafty is now active');

    const startSessionCmd = vscode.commands.registerCommand('drafty.startSession', startSessionHandler);
    const runBlockCmd = vscode.commands.registerCommand('drafty.runBlock', runBlockHandler);
    const terminateBlockCmd = vscode.commands.registerCommand('drafty.terminateBlock', terminateBlockHandler);

    // Register commands and CodeLens provider
    context.subscriptions.push(startSessionCmd, runBlockCmd, terminateBlockCmd);
    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider('markdown', new MarkdownCodeLensProvider())
    );
}

// ---------------------------------------------
// Ensure panel is open + gather Python envs
// ---------------------------------------------
async function ensurePanelAndEnvs() {
    if (!currentPanel) {
        const editor = vscode.window.activeTextEditor;
        let panel_title = "Code Execution Results";
        if (editor) {
            const mdFullPath = editor.document.uri.fsPath;
            panel_title = path.basename(mdFullPath, '.md') + ".md Results";
        }
        currentPanel = vscode.window.createWebviewPanel(
            'codeResults',
            panel_title,
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


        // ------------------------------
        // Set up message listener
        // ------------------------------
        currentPanel.webview.onDidReceiveMessage((message) => {
            if (message.command === 'changeEnv') {
                // user changed python environment
                selectedPythonPath = message.pythonPath;
                vscode.window.showInformationMessage(`Switched to: ${selectedPythonPath}`);

            } else if (message.command === 'changeMaxHeight') {
                // user changed the max height
                maxResultHeight = message.value;

                // Re-render so blocks get the new max-height
                updatePanel();

            } else if (message.command === 'saveState') {
                // user wants to save JSON of current block results
                handleSaveState();
            } else if (message.command === 'scrollToBlock') {
                // This message is from the extension itself to the webview (we don’t do anything here).
                // The webview code uses `scrollIntoView()` directly in its own script.
                // We do not need to handle it on the extension side. 
            }
        });

        // onDidDispose
        currentPanel.onDidDispose(() => {
            currentPanel = undefined;
            sessionState = undefined;
            PythonRunner.getInstance().clearState();
            runningProcesses.clear();
        });
    }
}

// ---------------------------------------------
// Start session: parse code blocks & detect environment
// ---------------------------------------------
async function startSessionHandler() {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'markdown') {
        vscode.window.showErrorMessage('Please open a Markdown file first');
        return;
    }

    await ensurePanelAndEnvs();

    // Attempt to load the *latest* state JSON for this MD file
    const docPath = editor.document.uri.fsPath; // full path to .md
    const existingState = tryLoadPreviousState(docPath);

    // Parse out code blocks from the markdown
    const markdown = editor.document.getText();
    const md = new MarkdownIt();
    const tokens = md.parse(markdown, {});
    const codeBlocks = extractCodeBlocks(tokens);

    // If we found previously saved state, we can restore it. Otherwise, create fresh session
    if (existingState) {
        sessionState = existingState;
        // Make sure we still track new code blocks if they appear
        codeBlocks.forEach((block) => {
            const blockId = `block-${block.position}`;
            if (!sessionState!.codeBlocks.has(blockId)) {
                sessionState!.codeBlocks.set(blockId, {
                    ...block,
                    metadata: { status: 'pending', timestamp: Date.now() },
                    outputs: []
                });
            }
        });
        vscode.window.showInformationMessage('Previous session state loaded.');
    } else {
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
        vscode.window.showInformationMessage('New session started!');
    }

    updatePanel();
}

// ---------------------------------------------
// Run a block
// ---------------------------------------------
async function runBlockHandler(range: vscode.Range) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        return;
    }

    if (!sessionState) {
        await startSessionHandler();
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

    // Force an update so the webview gets the new block container
    updatePanel();

    // -----------------------
    // auto-scroll/focus on this block
    // Once the block container is created, we can instruct the webview to scroll
    currentPanel?.webview.postMessage({
        command: 'scrollToBlock',
        blockId
    });

    // Handle partial streaming
    const onPartialOutput = (partialOutput: CellOutput) => {
        // 1) Store in session state
        const b = sessionState?.codeBlocks.get(blockId);
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

        // 2) Post a message to the webview to update just this block
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
        runningProcesses.delete(blockId);
    }

    blockExecution.metadata.executionTime = Date.now() - blockExecution.metadata.timestamp;

    // Final re-render
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

        updatePanel();
        vscode.window.showInformationMessage(`Terminated execution of block at line ${range.start.line}.`);
    } catch (err) {
        vscode.window.showErrorMessage(`Failed to terminate block: ${String(err)}`);
    }
}

// ---------------------------------------------
// Save the current sessionState to JSON
// invoked from the webview's "Save Results" button
// ---------------------------------------------
function handleSaveState() {
    if (!sessionState) {
        vscode.window.showWarningMessage('No session state to save.');
        return;
    }

    // <md-filename>-state-<yyyyMMdd>-<hhmm>.json
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const mdFullPath = editor.document.uri.fsPath;
    const baseName = path.basename(mdFullPath, '.md');

    const now = new Date();
    const yyyymmdd = now
        .toISOString()
        .slice(0, 10)
        .replace(/-/g, '');
    const hhmm = String(now.getHours()).padStart(2, '0') + String(now.getMinutes()).padStart(2, '0');
    const fileName = `${baseName}-state-${yyyymmdd}-${hhmm}.json`;

    // By default, save to the same folder as the .md
    let defaultFolder = path.dirname(mdFullPath);

    const fullSavePath = path.join(defaultFolder, fileName);

    // Write out the sessionState to a JSON object
    const dataToSave: any = serializeSessionState(sessionState);

    try {
        fs.writeFileSync(fullSavePath, JSON.stringify(dataToSave, null, 2), 'utf-8');
        vscode.window.showInformationMessage(`Results saved to: ${fullSavePath}`);

    } catch (err) {
        vscode.window.showErrorMessage(`Failed to save results: ${String(err)}`);
    }
}

// A helper function to remove any circular references
// and store codeBlocks as plain arrays for JSON
function serializeSessionState(state: SessionState) {
    const blocksArray = Array.from(state.codeBlocks.entries()).map(([blockId, exec]) => ({
        blockId,
        content: exec.content,
        info: exec.info,
        position: exec.position,
        metadata: exec.metadata,
        outputs: exec.outputs
    }));
    return {
        currentBlockIndex: state.currentBlockIndex,
        runCount: state.runCount,
        codeBlocks: blocksArray
    };
}

// Try to load the most recent JSON state for the given .md file
// Looks for <md-filename>-state-YYYYMMDD-HHMM.json in the same folder
function tryLoadPreviousState(mdFullPath: string): SessionState | undefined {
    const dir = path.dirname(mdFullPath);
    const baseName = path.basename(mdFullPath, '.md');
    const re = new RegExp(`^${baseName}-state-(\\d{8})-(\\d{4})\\.json$`);

    if (!fs.existsSync(dir)) {
        return undefined;
    }
    const files = fs.readdirSync(dir).filter((f) => re.test(f));
    if (files.length === 0) {
        return undefined;
    }

    // Sort files by date/time descending
    files.sort((a, b) => {
        const matchA = a.match(re)!;
        const matchB = b.match(re)!;
        const dateA = matchA[1] + matchA[2]; // yyyymmddhhmm
        const dateB = matchB[1] + matchB[2];
        return dateB.localeCompare(dateA); // descending
    });

    const latestFile = path.join(dir, files[0]);
    try {
        const raw = fs.readFileSync(latestFile, 'utf-8');
        const savedState = JSON.parse(raw);
        return deserializeSessionState(savedState);
    } catch (err) {
        console.error('Failed to load previous state:', err);
        return undefined;
    }
}

function deserializeSessionState(savedObj: any): SessionState {
    const blockMap = new Map<string, CodeBlockExecution>();
    for (const item of savedObj.codeBlocks) {
        blockMap.set(item.blockId, {
            content: item.content,
            info: item.info,
            position: item.position,
            metadata: item.metadata,
            outputs: item.outputs
        });
    }
    return {
        currentBlockIndex: savedObj.currentBlockIndex,
        runCount: savedObj.runCount,
        codeBlocks: blockMap
    };
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
// Extract code blocks
// ---------------------------------------------
function extractCodeBlocks(tokens: any[]): CodeBlock[] {
    const blocks: CodeBlock[] = [];
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (
            token.type === 'fence' &&
            token.info.trim() === 'python' &&
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
// Build the Webview HTML (includes new top widgets)
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

            // block container ID
            const blockContainerId = `result-block-${"block-" + block.position}`;

            // Pre-render existing outputs
            const outputsHtml = block.outputs
                .map((output) => createOutputHtml(output))
                .join('\n');

            return `
                <div class="block-container ${statusClass}"
                     id="${blockContainerId}"
                     style="max-height: ${maxResultHeight}px; overflow-y: auto;">
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

    // The top row now has:
    //  (1) Python env dropdown
    //  (2) "Max result height" input
    //  (3) "Save Results" button
    const editor = vscode.window.activeTextEditor;
    let panel_title = "Code Execution Results";
    if (editor) {
        const mdFullPath = editor.document.uri.fsPath;
        panel_title = path.basename(mdFullPath, '.md') + ".md Results";
    }
    
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <title>${panel_title}</title>
    <style>
        body {
            padding: 20px;
            font-family: var(--vscode-editor-font-family);
            line-height: 1.5;
            color: var(--vscode-editor-foreground);
            background-color: var(--vscode-editor-background);
        }
        .panel-top {
            display: flex;
            align-items: center;
            gap: 1rem;
            margin-bottom: 1em;
        }
        .panel-top label {
            margin-right: 0.3em;
        }
        select, input, button {
            font-size: 0.9rem;
        }

        .block-container {
            margin-bottom: 20px;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            overflow: hidden; /* We'll rely on inline style for max-height + scroll */
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
    <div class="panel-top">
        <!-- add the Max result height input -->
        <label for="envSelect"><strong>Python Interpreter:</strong></label>
        <select id="envSelect">${optionsHtml}</select>

        <label for="maxHeightInput"><strong>Max result height (px):</strong></label>
        <input type="number" id="maxHeightInput" min="50" step="10" value="${maxResultHeight}" />

        <!-- add a "Save Results" button -->
        <button id="saveButton">Save Results</button>
    </div>

    ${outputHtml}

    <script>
        const vscode = acquireVsCodeApi();

        // Env dropdown
        const envSelect = document.getElementById('envSelect');
        envSelect?.addEventListener('change', (event) => {
            vscode.postMessage({
                command: 'changeEnv',
                pythonPath: event.target.value
            });
        });

        // Listen for user updates to "maxHeightInput"
        const maxHeightInput = document.getElementById('maxHeightInput');
        maxHeightInput?.addEventListener('change', (event) => {
            const newVal = parseInt(event.target.value, 10);
            if (!isNaN(newVal) && newVal > 0) {
                vscode.postMessage({
                    command: 'changeMaxHeight',
                    value: newVal
                });
            }
        });

        // "Save Results" button
        const saveButton = document.getElementById('saveButton');
        saveButton?.addEventListener('click', () => {
            vscode.postMessage({
                command: 'saveState'
            });
        });

        // Listen for partial outputs from extension
        window.addEventListener('message', event => {
            const message = event.data;
            if (message.command === 'partialOutput') {
                const { blockId, output } = message;
                updateBlockOutput(blockId, output);
            }
            else if (message.command === 'scrollToBlock') {
                scrollToBlock(message.blockId);
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

        // Scroll/focus on the specified block
        function scrollToBlock(blockId) {
            const containerId = 'result-block-' + blockId;
            const blockContainer = document.getElementById(containerId);
            if (blockContainer) {
                blockContainer.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
