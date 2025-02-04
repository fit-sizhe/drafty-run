import * as path from "path";
import { CellOutput } from "../types";
import { PythonKernel } from "./implementations/PythonKernel";

/**
 * This KernelManager class is a backward‑compatible wrapper that
 * maintains a mapping from document paths to kernel instances.
 * It delegates operations to the new PythonKernel implementation.
 */
export class KernelManager {
  private kernels = new Map<string, PythonKernel>();

  /**
   * Launches a new kernel process for the given document if one isn’t already running.
   *
   * @param docPath - The document’s full path.
   * @param envPath - The Python interpreter/environment path.
   * @param onDataCallback - (Optional) A callback to be invoked for kernel stdout/stderr data.
   */
  public async startProcessForDoc(
    docPath: string,
    envPath: string,
    onDataCallback?: (output: CellOutput) => void,
  ): Promise<void> {
    if (this.kernels.has(docPath)) {
      // Kernel already started for this document.
      return;
    }
    const kernel = new PythonKernel();
    // Use the directory of the document as the working directory.
    await kernel.start(envPath, path.dirname(docPath));
    this.kernels.set(docPath, kernel);
  }

  /**
   * Enqueues code execution on the kernel for the given document.
   *
   * @param docPath - The document path.
   * @param code - The code to execute.
   * @param onDataCallback - (Optional) A callback that receives partial outputs.
   * @returns A promise that resolves with an object containing the outputs.
   */
  public queueCodeExecution(
    docPath: string,
    code: string,
    onDataCallback?: (output: CellOutput) => void,
  ): Promise<{ outputs: CellOutput[] }> {
    const kernel = this.kernels.get(docPath);
    if (!kernel) {
      throw new Error(`No kernel initialized for docPath=${docPath}`);
    }
    // Pass the onDataCallback to the kernel.execute method so that partial outputs are forwarded.
    return kernel.execute(code, onDataCallback);
  }

  /**
   * Attempts to interrupt/terminate code execution in the kernel for the given document.
   *
   * @param docPath - The document path.
   */
  public async terminateExecution(docPath: string): Promise<void> {
    const kernel = this.kernels.get(docPath);
    if (kernel) {
      await kernel.interrupt();
    }
  }

  /**
   * Clears global state. (Currently implemented as a no-op,
   * but can be extended to support a “soft reset” if needed.)
   */
  public clearState(): void {
    // No-op – or implement a soft reset here if desired.
  }

  /**
   * Disposes of the kernel for the specified document.
   *
   * @param docPath - The document path.
   */
  public disposeRunner(docPath: string): void {
    const kernel = this.kernels.get(docPath);
    if (kernel) {
      kernel.dispose();
      this.kernels.delete(docPath);
    }
  }

  /**
   * Disposes all running kernels.
   */
  public disposeAll(): void {
    for (const kernel of this.kernels.values()) {
      kernel.dispose();
    }
    this.kernels.clear();
  }
}
