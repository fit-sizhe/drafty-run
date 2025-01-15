import * as vscode from "vscode";
import { CodeBlockExecution, CellOutput } from "./types";
import { Environment } from "./env_setup";

interface PanelInfo {
  panel: vscode.WebviewPanel;
  messageDisposable?: vscode.Disposable;
  maxResultHeight: number;
}

export class WebviewManager {
  private static instance: WebviewManager;

  // docPath -> PanelInfo
  private panels = new Map<string, PanelInfo>();

  private constructor() {}

  static getInstance(): WebviewManager {
    if (!this.instance) {
      this.instance = new WebviewManager();
    }
    return this.instance;
  }

  /**
   * Create or reuse a panel for the given docPath.
   */
  async ensurePanel(
    context: vscode.ExtensionContext,
    docPath: string,
    messageHandler: (
      message: any,
      ctx: vscode.ExtensionContext,
      panel: vscode.WebviewPanel,
    ) => void,
    onPanelDisposed: (docPath: string) => void, // run cleanup when webview is closed
    title?: string,
  ): Promise<void> {
    if (!this.panels.has(docPath)) {
      // Create a new panel
      const filename = title || "Code Execution Results";
      const panel = vscode.window.createWebviewPanel(
        "codeResults",
        filename,
        vscode.ViewColumn.Beside,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
        },
      );

      const info: PanelInfo = {
        panel,
        maxResultHeight: 400,
      };

      // Set up message handling
      info.messageDisposable = panel.webview.onDidReceiveMessage((msg) => {
        messageHandler(msg, context, panel);
      });

      panel.onDidDispose(() => {
        info.messageDisposable?.dispose();
        this.panels.delete(docPath);
        // Tell extension.ts "the panel for docPath was closed"
        onPanelDisposed(docPath);
      });

      this.panels.set(docPath, info);
    }
  }

  /**
   * Reveal an existing panel (if any) for docPath.
   */
  revealPanel(docPath: string) {
    const info = this.panels.get(docPath);
    if (info) {
      info.panel.reveal(vscode.ViewColumn.Beside, true);
    }
  }

  getPanel(docPath: string): vscode.WebviewPanel | undefined {
    return this.panels.get(docPath)?.panel;
  }

  /**
   * Reverse lookup: given a panel, find which docPath it belongs to.
   */
  getDocPathForPanel(panel: vscode.WebviewPanel): string | undefined {
    for (const [docPath, info] of this.panels.entries()) {
      if (info.panel === panel) {
        return docPath;
      }
    }
    return undefined;
  }

  /**
   * Update the max height for a given docPath’s panel.
   */
  setMaxResultHeight(docPath: string, height: number): void {
    const info = this.panels.get(docPath);
    if (info) {
      info.maxResultHeight = height;
    }
  }

  /**
   * Create the HTML content for this docPath's webview and update it.
   */
  updateContent(
    docPath: string,
    blocks: Map<string, CodeBlockExecution>,
    environments: Environment[],
    selectedPath: string,
  ): void {
    const info = this.panels.get(docPath);
    if (!info) {
      return;
    }
    info.panel.webview.html = this.getWebviewContent(
      blocks,
      environments,
      selectedPath,
      info.maxResultHeight,
    );
  }

  /**
   * Optionally close all panels on extension deactivation.
   */
  disposeAllPanels() {
    for (const [, info] of this.panels) {
      info.messageDisposable?.dispose();
      info.panel.dispose();
    }
    this.panels.clear();
  }

  private getWebviewContent(
    blocks: Map<string, CodeBlockExecution>,
    environments: Environment[],
    selectedPath: string,
    maxResultHeight: number,
  ): string {
    // Build <option> tags from environments
    const optionsHtml = environments
      .map((env) => {
        const selectedAttr = env.path === selectedPath ? "selected" : "";
        return `<option value="${env.path}" ${selectedAttr}>${env.label}</option>`;
      })
      .join("");

    // We only want to display blocks that have actually run or are running
    const renderedBlocks = Array.from(blocks.values())
      .filter((b) => b.metadata.status !== "pending")
      .sort((a, b) => a.position - b.position);

    // Build each block's HTML
    const outputHtml = renderedBlocks
      .map((block) => {
        const statusClass = `status-${block.metadata.status}`;
        const executionTime = block.metadata.executionTime
          ? `(${(block.metadata.executionTime / 1000).toFixed(2)}s)`
          : "";
        const runLabel = block.metadata.runNumber
          ? `Output [${block.metadata.runNumber}]`
          : "Output [?]";

        const blockContainerId = `result-block-${"block-" + block.position}`;
        const outputsHtml = block.outputs
          .map((output) => this.createOutputHtml(output))
          .join("\n");

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
      .join("\n");

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
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
            flex-direction: column;
            align-items: left;
            margin-bottom: 0.2em;
        }
        .panel-row {
            max-width: 600px;
            min-width: 450px;
            display: flex;
            margin-bottom: 0.6em;
            
        }
        .panel-row label {
            margin-right: 0.3em;
        }
        select, input, button {
            font-size: 0.9rem;
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
        .vscode-button {
          cursor: pointer;
          flex: 1;
          margin-right: 0.5em;
          padding: 0.4em 0.8em;
          border: 1px solid var(--vscode-button-border);
          border-radius: 3px;
          background-color: var(--vscode-button-background);
          color: var(--vscode-button-foreground);
          font-size: 0.8rem;
        }
        .vscode-button:hover {
          background-color: var(--vscode-button-hoverBackground);
        }


        input[type="text"],
        input[type="number"],
        select {
          font-family: var(--vscode-editor-font-family);
          font-size: 0.8rem;
          flex: 1;
          color: var(--vscode-input-foreground);
          background-color: var(--vscode-input-background);
          border: 1px solid var(--vscode-button-background);
          padding: 4px 6px;
          border-radius: 3px;
        }
    </style>
</head>
<body>
    <div class="panel-top">
    <div class="panel-row">
        <label for="envSelect"><strong>Python:</strong></label>
        <select id="envSelect">${optionsHtml}</select>
        <button id="refreshButton" class="vscode-button" style="max-width: 200px; margin-left: 0.5em;" >Refresh</button>
    </div>
    <div class="panel-row">
        <label for="maxHeightInput"><strong>Max result height(px):</strong></label>
        <input type="number" id="maxHeightInput" min="50" step="50" value="${maxResultHeight}" />
    </div>
    <div class="panel-row">
        <button id="loadResultsButton" class="vscode-button">Load</button>
        <button id="saveAsButton" class="vscode-button">Save As</button>
        <button id="saveButton" class="vscode-button">Save</button>
        <button id="clearButton" class="vscode-button">Clear</button>
    </div>
    <div class="panel-row">
        <label><strong>Loaded JSON:</strong></label>
        <input type="text" id="loadedResultsPath" readonly style="background: none;" />
    </div>
    </div>

    ${outputHtml}

    <script>
        // Initialize API only if not already done
        const vscode = (function() {
            try {
                return acquireVsCodeApi();
            } catch {
                return window.vscode;  // Reuse existing instance
            }
        })();

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

        // "Clear Results" button
        const clearButton = document.getElementById('clearButton');
        clearButton?.addEventListener('click', () => {
            vscode.postMessage({
                command: 'clearState'
            });
        });

        // "Refresh Env" button
        const refreshButton = document.getElementById('refreshButton');
        refreshButton?.addEventListener('click', () => {
            vscode.postMessage({
                command: 'refreshEnv'
            });
        });

        // "Save Results" button
        const loadResultsButton = document.getElementById('loadResultsButton');
        loadResultsButton?.addEventListener('click', () => {
            vscode.postMessage({ command: 'loadResults' });
        });

        const saveAsButton = document.getElementById('saveAsButton');
        saveAsButton?.addEventListener('click', () => {
            vscode.postMessage({ command: 'saveAs' });
        });

        const saveButton = document.getElementById('saveButton');
        saveButton?.addEventListener('click', () => {
            // We'll use "save" to respect the extension config
            vscode.postMessage({ command: 'save' });
        });

        // Listen for partial outputs from extension
        window.addEventListener('message', event => {
            const message = event.data;
            if (message.command === 'updateLoadedPath') {
                const loadedPathBox = document.getElementById('loadedResultsPath');
                if (loadedPathBox) {
                    loadedPathBox.value = message.path || '';
                }
            }
            else if (message.command === 'partialOutput') {
                const { blockId, output } = message;
                updateBlockOutput(blockId, output);
            }
            else if (message.command === 'scrollToBlock') {
                scrollToBlock(message.blockId);
            }
        });

        function updateBlockOutput(blockId, output) {
            const containerId = 'result-block-' + blockId;
            const blockContainer = document.getElementById(containerId);
            if (!blockContainer) return;
            
            const outputsDiv = blockContainer.querySelector('.block-outputs');
            if (!outputsDiv) return;

            if (output.type === 'text') {
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
                const format = output.format || 'png';
                imgEl.src = 'data:image/' + format + ';base64,' + output.data;

            } else if (output.type === 'error') {
                const errDiv = document.createElement('div');
                errDiv.classList.add('output', 'error-output');
                errDiv.textContent = output.error;
                outputsDiv.appendChild(errDiv);

            } else if (output.type === 'rich') {
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

  private createOutputHtml(output: CellOutput): string {
    switch (output.type) {
      case "text":
        return `
                    <div class="output text-output ${output.stream || ""}">
                        ${this.escapeHtml(output.content)}
                    </div>`;
      case "image":
        return `
                    <div class="output image-output">
                        <img class="live-plot" src="data:image/${output.format || "png"};base64,${output.data}" 
                             alt="Output visualization" />
                    </div>`;
      case "error":
        return `
                    <div class="output error-output">
                        <div class="error-message">${this.escapeHtml(output.error)}</div>
                    </div>`;
      case "rich":
        if (output.format === "html") {
          return `<div class="output rich-output">${output.content}</div>`;
        } else {
          return `<div class="output rich-output">${this.escapeHtml(output.content)}</div>`;
        }
      default:
        return "";
    }
  }

  private escapeHtml(unsafe: string): string {
    return unsafe
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }
}
