import * as vscode from "vscode";
import { CodeBlockExecution, CellOutput } from "../types";
import { Environment } from "../EnvironmentManager";
import { parseDraftyId } from "../codeBlockParser";

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
   * Update the HTML content for a specific result block
   */
  updateElementInWebview(
    panel: vscode.WebviewPanel,
    elementId: string,
    newContent: string
  ) {
    panel.webview.postMessage({
      command: 'updateElement',
      elementId,
      content: newContent,
    });
  }

  /**
   * Create the HTML content for this docPath's webview and update it.
   */
  updateContent(
    docPath: string,
    blocks: Map<string, CodeBlockExecution>,
    sortedBellies: string[],
    environments: Environment[],
    selectedPath: string,
  ): void {
    const info = this.panels.get(docPath);
    if (!info) {
      return;
    }
    info.panel.webview.html = this.getWebviewContent(
      blocks,
      sortedBellies,
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
    sortedBellies: string[], // sorted belly groups
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

    const renderedBlocks = Array.from(blocks.values())
      // CONFIG: comment the line below to show all pending blocks
      .filter((b) => b.metadata.status !== "pending")
      .sort((a, b) => {
        // parse IDs
        const aId = parseDraftyId(a.metadata?.bindingId || "");
        const bId = parseDraftyId(b.metadata?.bindingId || "");

        // If both parse, compare (head, belly, tail)
        if (aId && bId) {
          // compare belly
          if (aId.belly !== bId.belly) {
            return sortedBellies.indexOf(aId.belly) - sortedBellies.indexOf(bId.belly);
          }
          // compare tail
          return aId.tail - bId.tail;
        } 
        // fallback to position
        return (a.position ?? 0) - (b.position ?? 0);
      });

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

        // If we have a valid bindingId, prefer that, else fallback to old "block-position"
        const containerKey = block.metadata.bindingId??"block-" + block.position;
        let resultTitle: string;
        if (block.bindingId && block.title) {
          resultTitle = block.title + " (" + block.bindingId.tail + ")";
        } else resultTitle = containerKey;

        const blockContainerId = `result-block-${containerKey}`;
        const outputsHtml = block.outputs
          .map((output) => this.createOutputHtml(output))
          .join("\n");

        return `
                    <div class="block-container ${statusClass}"
                         id="${blockContainerId}"
                         style="max-height: ${maxResultHeight}px; overflow-y: auto; overflow-x: auto;">
                        <div class="block-header">
                            <span class="status">${runLabel}</span>
                            <span class="title">${resultTitle}</span>
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
            padding-bottom: 800px;
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
        .title {
            color: var(--vscode-descriptionForeground);
        }
        .block-outputs {
            padding: 10px;
        }
        .output {
            margin-bottom: 10px;
            white-space: pre;
        }
        .text-output {
            text-align: left;
            font-family: var(--vscode-editor-font-family);
        }
        .text-output.stderr {
            color: var(--vscode-errorForeground);
        }
        .image-output img {
            max-width: 100%;
            height: auto;
        }
        .live-plot {
            display: block;
            margin-left: 0;
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
                const resultBlocks = document.querySelectorAll('[id^="result-block-"]');
                resultBlocks.forEach(block => {
                  block.style.maxHeight = newVal+"px";
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

        // Listen for commands from extension
        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.command) {
                case 'reorderBlocks':
                  reorderBlockElements(message.order, message.focusedId, message.rmOrphaned);
                  break;

                case 'updateBlockStatus':
                  updateBlockStatus(message.containerId, message.status, message.runNum, message.clearContent, message.title, message.executionTime);
                  break;

                case "updateEnvOptions":
                  updateEnvOptions(message.envs, message.selected);
                  break;

                case 'updateLoadedPath':
                  const loadedPathBox = document.getElementById('loadedResultsPath');
                  if (loadedPathBox) {
                      loadedPathBox.value = message.path || '';
                  }
                  break;

                case 'partialOutput':
                  updateBlockOutput(message.blockId, message.output);
                  break;

                case 'scrollToBlock':
                  scrollToBlock(message.blockId);
                  break;
            }
        });

        function reorderBlockElements(idArray, focusedId, rmOrphaned){
          const filteredIds = idArray.filter(id => id.indexOf("999") === -1);
          const finalOrder = filteredIds.map(id => "result-block-" + id);
          
          let focusedFullId;
          if (focusedId && filteredIds.includes(focusedId)) {
            focusedFullId = "result-block-" + focusedId;
          }
          
          const container = document.body;
          let currentNodes = Array.from(container.querySelectorAll("div.block-container[id^='result-block-DRAFTY-ID-']"));

          // iterate over finalOrder and for each desired ID:
          for (let i = 0; i < finalOrder.length; i++) {
            const desiredId = finalOrder[i];
            // Try to find a node among currentNodes that has the desiredId.
            let existingIndex = currentNodes.findIndex(node => node.id === desiredId);
            if (existingIndex !== -1) {
              if (existingIndex !== i) {
                // Move it to the correct position within the result-block group.
                container.insertBefore(currentNodes[existingIndex], currentNodes[i]);
                // Rearrange our currentNodes array accordingly.
                const [node] = currentNodes.splice(existingIndex, 1);
                currentNodes.splice(i, 0, node);
              }
            } else {
              // No node with desiredId exists.
              // Only create a new node if desiredId equals focusedFullId.
              if (focusedFullId && desiredId === focusedFullId) {
                const idSuffix = desiredId.substring("result-block-".length);
                const newNode = createResultBlock(idSuffix);
                // Determine the proper insertion point among the result block nodes.
                // If i is less than currentNodes.length, insert before the node at index i.
                // Otherwise, if there is at least one result block node, insert after the last one.
                if (i < currentNodes.length) {
                  container.insertBefore(newNode, currentNodes[i]);
                } else if (currentNodes.length > 0) {
                  // Insert after the last result block node.
                  const lastNode = currentNodes[currentNodes.length - 1];
                  if (lastNode.nextSibling) {
                    container.insertBefore(newNode, lastNode.nextSibling);
                  } else {
                    container.appendChild(newNode);
                  }
                } else {
                  container.appendChild(newNode);
                }
                // Insert the new node into our currentNodes array at position i.
                currentNodes.splice(i, 0, newNode);
              }
            }
          }
          
          if (rmOrphaned) {
            const allNodes = Array.from(container.querySelectorAll("div.block-container[id^='result-block-DRAFTY-ID-']"));
            allNodes.forEach(node => {
              if (!finalOrder.includes(node.id)) {
                container.removeChild(node);
              }
            });
          }
        }

        function createResultBlock(idSuffix) {
          const container = document.createElement("div");
          container.className = "block-container status-pending";
          container.id = "result-block-" + idSuffix;
          container.style.maxHeight = "400px";
          container.style.overflowY = "auto";

          const header = document.createElement("div");
          header.className = "block-header";

          const spanStatus = document.createElement("span");
          spanStatus.className = "status";
          spanStatus.textContent = "Output [?]";

          const spanTitle = document.createElement("span");
          spanTitle.className = "title";
          spanTitle.textContent = idSuffix;

          const spanTime = document.createElement("span");
          spanTime.className = "time";
          spanTime.textContent = "";

          header.appendChild(spanStatus);
          header.appendChild(spanTitle);
          header.appendChild(spanTime);

          container.appendChild(header);

          const outputsDiv = document.createElement("div");
          outputsDiv.className = "block-outputs";

          container.appendChild(outputsDiv);

          return container;
        }

        function updateBlockStatus(blockId, status, runNum, clearContent, title, executionTime) {
            const containerId = 'result-block-' + blockId;
            const blockElement = document.getElementById(containerId);
            if (!blockElement) return;
            const statusClass = 'status-'+status;
            const execTime = executionTime?"("+(executionTime/1000).toFixed(2)+"s)":"";
            const runLabel = runNum ? 'Output ['+runNum+']': "Output [?]";
            let resultTitle;
            if (title) {
              resultTitle = title + " (" + blockId.split('-')[3] + ")";
            } else resultTitle = blockId;

            [...blockElement.classList].forEach(cls => {
              if (cls.startsWith("status-")) {
                blockElement.classList.remove(cls);
              }
            });
            blockElement.classList.add(statusClass);

            const headerElement = blockElement.querySelector(".block-header");
            const outputElement = blockElement.querySelector(".block-outputs");
            
            if (headerElement) {
              const statusSpan = headerElement.querySelector("span.status");
              if (statusSpan) {
                statusSpan.textContent = runLabel;
              }
              const titleSpan = headerElement.querySelector("span.title");
              if (titleSpan) {
                titleSpan.textContent = resultTitle;
              }
              const timeSpan = headerElement.querySelector("span.time");
              if (timeSpan) {
                timeSpan.textContent = execTime;
              }
            }
            
            if (outputElement && clearContent){
              outputElement.innerHTML = "";
            }
        }

        function updateEnvOptions(envs, selected) {
          const selector = document.getElementById("envSelect");
          selector.innerHTML = "";
          const options = envs
            .map((env) => {
              const selectedAttr = env.path === selected ? true : false;
              const option = document.createElement("option");
              option.value = env.path;
              option.selected = selectedAttr;
              option.innerText = env.label;
              return option;
            });
          for (const opt of options){
            selector.appendChild(opt);
          }
        }

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
                // Listen for scroll end
                let isScrolling;
                blockContainer.addEventListener('scroll', () => {
                  clearTimeout(isScrolling);
                  isScrolling = setTimeout(() => {
                    // Notify extension after scroll finishes
                    vscode.postMessage({ alert: 'scrollIntoViewCompleted' });
                  }, 600); // Adjust here to match animation duration
                });
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
                    <div class="output text-output ${output.stream || ""}" style="white-space: pre;">${output.content}</div>`;
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
        return `<div class="output rich-output">${output.content}</div>`;
      default:
        return "";
    }
  }


  /**
   * Reorder block containers in the Webview to match new document order.
   * The newOrder is an array of container IDs in the desired order.
   */
  public reorderBlocks(docPath: string, newOrder: string[], focusedId: string, rmOrphaned?: boolean) {
    const info = this.panels.get(docPath);
    if (!info) return;
    const panel = info.panel;

    panel.webview.postMessage({
      command: "reorderBlocks",
      order: newOrder,
      focusedId,
      rmOrphaned: rmOrphaned??false
    });
  }

  /**
   * update the status and the execution time, clear output content or not
   */
  public updateBlockStatus(
    docPath: string, 
    containerId: string, 
    status: string, 
    runNum: number,
    clearContent: boolean,
    title?: string | undefined,
    executionTime?: number,
  ) {
    const info = this.panels.get(docPath);
    if (!info) return;
    const panel = info.panel;
    panel.webview.postMessage({
      command: "updateBlockStatus",
      containerId,
      status,
      runNum,
      clearContent,
      title,
      executionTime
    });
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
