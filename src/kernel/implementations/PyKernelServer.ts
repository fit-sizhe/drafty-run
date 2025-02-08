import * as path from "path";
import { CellOutput } from "../../types";
import { PythonKernel } from "./PythonKernel";
import { ILanguageServer } from "../KernelServerRegistry";

export class PyKernelServer implements ILanguageServer {
  private kernels = new Map<string, PythonKernel>();

  async startProcessForDoc(
    docPath: string,
    envPath: string,
    onDataCallback?: (output: CellOutput) => void,
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
    _envPath: string,
    _blockId: string,
    onPartialOutput?: (output: CellOutput) => void,
  ) {
    const kernel = this.kernels.get(docPath);
    if (!kernel) {
      throw new Error(`No kernel initialized for docPath=${docPath}`);
    }
    // Pass the onPartialOutput to the kernel.execute method so that partial outputs are forwarded.
    return kernel.execute(code, onPartialOutput);
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

  disposeRunner(docPath: string): void {
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
