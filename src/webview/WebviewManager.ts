import * as vscode from "vscode";
import * as fs from "fs";
import { CodeBlockExecution, CellOutput } from "../types";
import { Environment } from "../managers/EnvironmentManager";
import { parseDraftyId } from "../parser/draftyid";
import { Input, Slider } from "../parser/directives";
import { INIT_MAX_RESULT_HEIGHT } from "./fragments/config";

interface PanelInfo {
  panel: vscode.WebviewPanel;
  messageDisposable?: vscode.Disposable;
  maxResultHeight: number;
}

export class WebviewManager {
  private static instance: WebviewManager;

  // docPath -> PanelInfo
  private panels = new Map<string, PanelInfo>();

  // Each Webview can reference it for loading scripts, etc.
  private extensionUri: vscode.Uri | undefined;

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
      panel: vscode.WebviewPanel
    ) => void,
    onPanelDisposed: (docPath: string) => void, // run cleanup when webview is closed
    title?: string
  ): Promise<void> {
    // Store extensionUri once in our manager
    if (!this.extensionUri) {
      this.extensionUri = context.extensionUri;
    }

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
        }
      );

      const info: PanelInfo = {
        panel,
        maxResultHeight: INIT_MAX_RESULT_HEIGHT,
      };

      // Set up message handling
      info.messageDisposable = panel.webview.onDidReceiveMessage((msg) => {
        messageHandler(msg, context, panel);
      });

      panel.onDidDispose(() => {
        info.messageDisposable?.dispose();
        this.panels.delete(docPath);
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
      command: "updateElement",
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
    selectedPath: string
  ): void {
    const info = this.panels.get(docPath);
    if (!info || !this.extensionUri) {
      return;
    }

    // Build HTML
    const htmlContent = this.getWebviewContent(
      info.panel.webview,
      this.extensionUri,
      blocks,
      sortedBellies,
      environments,
      selectedPath,
      info.maxResultHeight
    );

    // Update the webview HTML
    info.panel.webview.html = htmlContent;
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

  /**
   * Reorder block containers in the Webview to match new document order.
   */
  public reorderBlocks(
    docPath: string,
    newOrder: string[],
    focusedId: string,
    rmOrphaned?: boolean
  ) {
    const info = this.panels.get(docPath);
    if (!info) return;
    const panel = info.panel;

    panel.webview.postMessage({
      command: "reorderBlocks",
      order: newOrder,
      focusedId,
      rmOrphaned: rmOrphaned ?? false,
    });
  }

  /**
   * Update the status and the execution time, clear output content or not
   */
  public updateBlockStatus(
    docPath: string,
    containerId: string,
    status: string,
    runNum: number,
    clearContent: boolean,
    title?: string,
    executionTime?: number
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
      executionTime,
    });
  }

  // ----------------------------------------
  // Private helper to build the webview HTML
  // ----------------------------------------
  private getWebviewContent(
    webview: vscode.Webview,
    extensionUri: vscode.Uri,
    blocks: Map<string, CodeBlockExecution>,
    sortedBellies: string[],
    environments: Environment[],
    selectedPath: string,
    maxResultHeight: number
  ): string {
    // Build environment <option> list
    const optionsHtml = environments
      .map((env) => {
        const selectedAttr = env.path === selectedPath ? "selected" : "";
        return `<option value="${env.path}" ${selectedAttr}>${env.label}</option>`;
      })
      .join("");

    // Render code blocks
    const renderedBlocks = Array.from(blocks.values())
      .filter((b) => b.metadata.status !== "pending") // optional filter
      .sort((a, b) => {
        const aId = parseDraftyId(a.metadata?.bindingId || "");
        const bId = parseDraftyId(b.metadata?.bindingId || "");

        if (aId && bId) {
          if (aId.belly !== bId.belly) {
            return (
              sortedBellies.indexOf(aId.belly) -
              sortedBellies.indexOf(bId.belly)
            );
          }
          return aId.tail - bId.tail;
        }
        return (a.position ?? 0) - (b.position ?? 0);
      });

    const outputHtml = renderedBlocks
      .map((block) => this.createBlockHtml(block, maxResultHeight))
      .join("\n");

    // Load template from disk
    const htmlPath = vscode.Uri.joinPath(
      extensionUri,
      "assets",
      "template.html"
    );
    const templateHtml = fs.readFileSync(htmlPath.fsPath, "utf-8");

    // The path to the bundled JS (e.g. "dist/main.js" from esbuild)
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, "dist", "main.js")
    );

    // Replace placeholders in the template
    let finalHtml = templateHtml
      .replace("{{SCRIPT_URI}}", scriptUri.toString())
      .replace("{{ENV_OPTIONS}}", optionsHtml)
      .replace("{{OUTPUT_BLOCKS}}", outputHtml)
      .replace("{{MAX_RESULT_HEIGHT}}", maxResultHeight.toString());

    return finalHtml;
  }

  /**
   * Create a single block’s HTML
   */
  private createBlockHtml(block: CodeBlockExecution, maxResultHeight: number) {
    const statusClass = `status-${block.metadata.status}`;
    const executionTime = block.metadata.executionTime
      ? `(${(block.metadata.executionTime / 1000).toFixed(2)}s)`
      : "";
    const runLabel = block.metadata.runNumber
      ? `Output [${block.metadata.runNumber}]`
      : "Output [?]";

    const containerKey = block.metadata.bindingId ?? `block-${block.position}`;

    let resultTitle: string;
    if (block.bindingId && block.title) {
      resultTitle = `${block.title} (${block.bindingId.belly}-${block.bindingId.tail})`;
    } else {
      resultTitle = containerKey;
    }

    const blockContainerId = `result-block-${containerKey}`;
    const outputsHtml = block.outputs
      .map((o) =>
        this.createOutputHtml(
          o,
          block.metadata.bindingId ?? "block-" + block.position
        )
      )
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
      </div>
    `;
  }

  /**
   * Render a single CellOutput as HTML
   */
  private createOutputHtml(output: CellOutput, drafty_id: string): string {
    switch (output.type) {
      case "text":
        return `
          <div class="output text-output ${
            output.stream || ""
          }">${this.escapeHtml(output.content)}</div>`;
      case "widget":
        let controls = output.content.directives?.controls
          .map((c) => this.createControlHtml(c, drafty_id))
          .join("\n");
        return `
          <div class="output widget-output">
            <div class="widget-controls" id="widget-controls-${
              output.content.drafty_id
            }">
              ${controls}
            </div>
            <div class="widget-plot" id="pctrl-${
              output.content.drafty_id
            }-plot">
              ${JSON.stringify(output.content.results)}
            </div>
          </div>`;
      case "image":
        return `
          <div class="output image-output">
            <img
              class="live-plot"
              src="data:image/${output.format ?? "png"};base64,${output.data}"
              alt="Output visualization"
            />
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
   * Creates an HTML string for a given control.
   *
   * - For a Slider, it creates an `<input type="range">` element.
   * - For an Input with type "number", it creates an `<input type="number">` element.
   * - For an Input with type "options", it creates a `<select>` element with `<option>` children.
   */
  private createControlHtml(
    control: Input | Slider,
    drafty_id: string
  ): string {
    let html = `<div class="widget-control" id="pctrl-[${control.param}]-${drafty_id}">`;
    html += `<label for="pctrl-[${control.param}]-${drafty_id}-gui">${control.param}</label>`;

    // Generate the control element based on its type
    if (control.type === "slider") {
      // Create a slider (range input)
      html +=
        `<input type="range" id="pctrl-[${control.param}]-${drafty_id}-gui" name="${control.param}" ` +
        `min="${control.min}" max="${control.max}"` +
        (control.step !== undefined
          ? ` step="${control.step}"`
          : `step="${(control.max - control.min) / 50}"`) +
        `>`;
      // Create current value 
      html += `<span>${control.current}</span>`
    } else if (control.type === "number") {
      // Create a number input
      html += `<input type="number" id="pctrl-[${control.param}]-${drafty_id}-gui" name="${control.param}">`;
    } else if (control.type === "options") {
      // Create a select element with options
      html += `<select id="pctrl-[${control.param}]-${drafty_id}-gui" name="${control.param}">`;
      if (control.options && control.options.length > 0) {
        control.options.forEach((option) => {
          html += `<option value="${option}">${option}</option>`;
        });
      }
      html += `</select>`;
    } else {
      throw new Error("Unknown control type");
    }

    html += `</div>`;
    return html;
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
