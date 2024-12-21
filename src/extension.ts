import * as vscode from 'vscode';
import * as MarkdownIt from 'markdown-it';
import { PythonRunner } from './pythonRunner';
import { CellOutput, CodeBlock } from './types';

// State management
let currentPanel: vscode.WebviewPanel | undefined = undefined;
let nodeGlobalState: { [key: string]: any } = {};
let selectedEnvironment: string | undefined = undefined;

// Session state
interface SessionState {
    codeBlocks: CodeBlock[];
    currentBlockIndex: number;
    allOutputs: CellOutput[];
}
let sessionState: SessionState | undefined = undefined;

async function executeNodeCode(code: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        try {
            // Inject global state
            const stateInjection = Object.entries(nodeGlobalState)
                .map(([key, value]) => `let ${key} = ${JSON.stringify(value)};`)
                .join('\n');

            const fullCode = `${stateInjection}\n${code}\n`;
            const result = eval(fullCode);
            
            // Update global state
            const context = eval(`(${fullCode})\n(() => ({ ...global }))()`);
            nodeGlobalState = { ...nodeGlobalState, ...context };
            
            resolve(String(result));
        } catch (error) {
            reject(error);
        }
    });
}

export function activate(context: vscode.ExtensionContext) {
    console.log('Markdown Code Runner is now active');

    // Register commands
    let runNextBlock = vscode.commands.registerCommand('mdrun.runNextBlock', async () => {
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
                const outputs = await PythonRunner.getInstance().executeCode(currentBlock.content);
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
            const errorMessage = error instanceof Error ? error.message : String(error);
            sessionState.allOutputs.push({
                type: 'error',
                timestamp: Date.now(),
                error: errorMessage,
                traceback: []
            });
            updatePanel(sessionState.allOutputs);
        }

        sessionState.currentBlockIndex++;
    });

    let startSession = vscode.commands.registerCommand('mdrun.startSession', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'markdown') {
            vscode.window.showErrorMessage('Please open a markdown file first');
            return;
        }

        // Ask for environment if not already selected
        if (!selectedEnvironment) {
            const environments = ['python', 'node'];
            const selected = await vscode.window.showQuickPick(environments, {
                placeHolder: 'Select execution environment'
            });
            
            if (!selected) {
                return;
            }
            selectedEnvironment = selected;
        }

        // Create and show panel
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

            currentPanel.onDidDispose(() => {
                currentPanel = undefined;
                nodeGlobalState = {};
                selectedEnvironment = undefined;
                sessionState = undefined;
                // Clear Python runner state
                PythonRunner.getInstance().clearState();
            });
        }

        // Parse markdown and extract code blocks
        const markdown = editor.document.getText();
        const md = new MarkdownIt();
        const tokens = md.parse(markdown, {});
        const codeBlocks = extractCodeBlocks(tokens);

        // Initialize session state
        sessionState = {
            codeBlocks: codeBlocks,
            currentBlockIndex: 0,
            allOutputs: []
        };

        // Show initial empty panel
        updatePanel([]);

        // Show information message
        vscode.window.showInformationMessage('Session started. Use "Run Next Block" command to execute code blocks.');
    });

    context.subscriptions.push(runNextBlock, startSession);
}

function extractCodeBlocks(tokens: any[]): CodeBlock[] {
    const blocks: CodeBlock[] = [];
    for (let i = 0; i < tokens.length; i++) {
        if (tokens[i].type === 'fence' && 
            (tokens[i].info === selectedEnvironment || tokens[i].info === '')) {
            blocks.push({
                content: tokens[i].content,
                info: tokens[i].info
            });
        }
    }
    return blocks;
}

function updatePanel(outputs: CellOutput[]) {
    if (currentPanel) {
        currentPanel.webview.html = getWebviewContent(outputs);
    }
}

function getWebviewContent(outputs: CellOutput[]): string {
    return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Code Execution Results</title>
        <style>
            body {
                padding: 20px;
                font-family: var(--vscode-editor-font-family);
                line-height: 1.5;
                color: var(--vscode-editor-foreground);
                background-color: var(--vscode-editor-background);
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
            .separator {
                border-top: 1px solid var(--vscode-panel-border);
                margin: 10px 0;
            }
        </style>
    </head>
    <body>
        ${outputs.map(output => {
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
                                     alt="Output visualization"
                                     ${output.metadata?.width ? `width="${output.metadata.width}"` : ''}
                                     ${output.metadata?.height ? `height="${output.metadata.height}"` : ''} />
                            </div>
                        </div>`;
                case 'error':
                    return `
                        <div class="output-container">
                            <div class="output error-output">
                                <div class="error-message">${escapeHtml(output.error)}</div>
                                ${output.traceback?.length ? `
                                    <div class="error-traceback">
                                        ${output.traceback.map(frame => `<div>${escapeHtml(frame)}</div>`).join('')}
                                    </div>
                                ` : ''}
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
        }).join('\n')}
    </body>
    </html>`;
}

function escapeHtml(unsafe: string): string {
    return unsafe
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

export function deactivate() {
    nodeGlobalState = {};
    selectedEnvironment = undefined;
    sessionState = undefined;
    if (currentPanel) {
        currentPanel.dispose();
    }
    PythonRunner.getInstance().clearState();
}
