import * as path from "path";
import * as vscode from "vscode";
import {
  CellOutput,
  CodeBlockExecution,
  ErrorOutput,
  TextOutput,
  WidgetOutput,
} from "../../types";
import { PythonKernel } from "./PythonKernel";
import { ILanguageServer } from "../KernelServerRegistry";
import { parseDirectivesFromStr } from "../../parser/directives";
import {
  convertParseError,
  generatePythonSnippet,
} from "../../utils/widgetUtils";
import { StateManager } from "../../managers/StateManager";

export class PyKernelServer implements ILanguageServer {
  private kernels = new Map<string, PythonKernel>();

  async startProcessForDoc(docPath: string, envPath: string) {
    if (this.kernels.has(docPath)) {
      // Kernel already started for this document.
      return;
    }
    const kernel = new PythonKernel();
    // Use the directory of the document as the working directory.
    await kernel.start(envPath, path.dirname(docPath));
    this.kernels.set(docPath, kernel);
  }

  executeCode(
    docPath: string,
    code: string,
    onPartialOutput?: (output: CellOutput) => void
  ) {
    const kernel = this.kernels.get(docPath);
    if (!kernel) {
      throw new Error(`No kernel initialized for docPath=${docPath}`);
    }
    // Pass the onPartialOutput to the kernel.execute method so that partial outputs are forwarded.
    return kernel.execute(code, onPartialOutput);
  }

  async runSingleBlock(
    docPath: string,
    code: string,
    blockState: CodeBlockExecution,
    panel?: vscode.WebviewPanel
  ) {
    const onPartialOutput = (partialOutput: CellOutput) => {
      if (partialOutput.type === "image") {
        // Overwrite old images from the same run
        const oldImageIndex = blockState.outputs.findIndex(
          (o) => o.type === "image"
        );
        if (oldImageIndex !== -1) {
          blockState.outputs[oldImageIndex] = partialOutput;
        } else {
          blockState.outputs.push(partialOutput);
        }
      } else {
        blockState.outputs.push(partialOutput);
      }
      panel?.webview.postMessage({
        command: "partialOutput",
        blockId: blockState.metadata.bindingId,
        output: partialOutput,
      });
    };

    await this.executeCode(docPath, code, onPartialOutput);
  }

  /**
   * Creates a callback function to handle cell outputs in runDirectiveInit
   * and runDirectiveUpdate
   *
   * @param block - The code block execution state (either blockState or blockInSession).
   * @param panel - The webview panel to send messages to.
   * @returns A function that handles CellOutput objects.
   */
  private createOnDataCallback(
    block: CodeBlockExecution,
    panel: vscode.WebviewPanel
  ): (output: CellOutput) => void {
    return (output: CellOutput) => {
      if (output.type === "text") {
        let newOutput;
        // relay runtime errors
        if(output.stream == "stderr") {
          newOutput = {
            type: "error",
            timestamp: output.timestamp,
            error: output.content.split("\n")[0].split(".py:")[1]
          } as ErrorOutput;
          block.outputs.push(newOutput);

        } else {
          const content = JSON.parse(output.content.slice(1, -1));
          newOutput = {
            timestamp: output.timestamp,
            ...content,
          } as WidgetOutput;
          // make sure the first item is the only widgetOpt
          if (block.outputs.length == 0) {
            block.outputs.push(newOutput);
          } else {
            if (block.outputs[0].type == "widget") {
              block.outputs[0] = newOutput;
            } else {
              block.outputs = [newOutput, ...block.outputs];
            }
          }
        }
        panel.webview.postMessage({
          command: "partialOutput",
          blockId: block.metadata.bindingId,
          output: newOutput,
        });
      } else {
        block.outputs.push(output);
        panel.webview.postMessage({
          command: "partialOutput",
          blockId: block.metadata.bindingId,
          output: output,
        });
      }
    };
  }

  /*
   ** parse directives,
   ** send generated code to kernel, and
   ** relay results(type=="init") to webview;
   ** should be only used in commands.ts
   */
  async runDirectiveInit(
    docPath: string,
    code: string,
    blockState: CodeBlockExecution,
    panel: vscode.WebviewPanel
  ): Promise<void> {
    const parseRes = parseDirectivesFromStr(code);
    if (!parseRes.directives) {
      return;
    }

    // update directives for block state
    blockState.directives = parseRes.directives;

    // if "errors" is not empty, we send them all to webview
    if (parseRes.errors.length > 0) {
      blockState.metadata.status = "error";
      for (const err of parseRes.errors) {
        let errOutput = convertParseError(err);
        blockState.outputs.push(errOutput);
        await panel.webview.postMessage({
          command: "partialOutput",
          blockId: blockState.metadata.bindingId,
          output: errOutput,
        });
      }
      return;
    }

    if (parseRes.directives.plot_executes.length == 0) return;

    // if no error, generate code snippet for execution
    const initSnippet = generatePythonSnippet(
      parseRes.directives,
      blockState.metadata.bindingId!
    );
    const onData = this.createOnDataCallback(blockState, panel);

    // run generated code
    await this.executeCode(docPath, initSnippet, onData);
  }

  /*
   ** update current values of directives,
   ** send generated code to kernel, and
   ** relay results(type=="update") to webview;
   ** should be only used in panelOps.handleWebviewMessage
   */
  async runDirectiveUpdate(
    docPath: string,
    drafty_id: string,
    updates: Map<string, number | string>,
    panel: vscode.WebviewPanel,
    blockInSession?: CodeBlockExecution
  ) {
    if (!blockInSession)
      blockInSession = StateManager.getInstance()
        .getSession(docPath)
        ?.codeBlocks.get(drafty_id);
    if (!blockInSession) {
      vscode.window.showErrorMessage(
        `No info found for the block: ${drafty_id}!`
      );
      return;
    }
    if (
      !blockInSession.directives ||
      blockInSession.directives?.plot_executes.length == 0
    ) {
      vscode.window.showErrorMessage(
        `No directive found for the block: ${drafty_id}!`
      );
      return;
    }

    // update current values in control directives
    for (const param of updates.keys()) {
      for (const ctrl of blockInSession.directives.controls) {
        if (ctrl.param === param) ctrl.current = updates.get(param)!;
      }
    }
    const updateSnippet = generatePythonSnippet(
      blockInSession.directives,
      drafty_id,
      "update"
    );

    const onData = this.createOnDataCallback(blockInSession, panel);

    await this.executeCode(docPath, updateSnippet, onData);
  }

  async terminateExecution(docPath: string): Promise<void> {
    const kernel = this.kernels.get(docPath);
    if (kernel) {
      await kernel.interrupt();
    }
  }

  clearState(_docPath: string): void {
    // no-op for now
  }

  disposeServer(docPath: string): void {
    const kernel = this.kernels.get(docPath);
    if (kernel) {
      kernel.dispose();
      this.kernels.delete(docPath);
    }
  }

  disposeAll(): void {
    for (const kernel of this.kernels.values()) {
      kernel.dispose();
    }
    this.kernels.clear();
  }
}
