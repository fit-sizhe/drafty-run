import * as path from "path";
import * as vscode from "vscode";
import { CellOutput, CodeBlockExecution } from "../../types";
import { PythonKernel } from "./PythonKernel";
import { ILanguageServer } from "../KernelServerRegistry";

export class PyKernelServer implements ILanguageServer {
  private kernels = new Map<string, PythonKernel>();

  async startProcessForDoc(
    docPath: string,
    envPath: string,
  ) {
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
    onPartialOutput?: (output: CellOutput) => void,
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
          (o) => o.type === "image",
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

    await this.executeCode(
      docPath,
      code,
      onPartialOutput,
    );
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
