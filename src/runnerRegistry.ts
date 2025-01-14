import { CellOutput } from "./types";
// import { PythonRunner } from './pythonRunner';
import { KernelManager } from "./kernelManager";

// Interface for language runners
export interface ILanguageRunner {
  executeCode(
    docPath: string,
    code: string,
    envPath: string,
    blockId: string,
    onPartialOutput?: (output: CellOutput) => void,
  ): Promise<{ outputs: CellOutput[] }>;
  // clear global status of runner class
  clearState(docPath: string): void;
  disposeRunner(docPath: string): void;
  // start a background process for specific doc
  startProcessForDoc(
    docPath: string,
    envPath: string,
    onDataCallback?: (output: CellOutput) => void): void;
  terminateExecution?(docPath: string): void; // Optional for backward compatibility
}

// Adapter to make PythonRunner match ILanguageRunner interface
export class PythonRunnerAdapter implements ILanguageRunner {
  private manager = new KernelManager();

  startProcessForDoc(
    docPath: string,
    envPath: string,
    onDataCallback?: (output: CellOutput) => void,
  ) {
    this.manager.startProcessForDoc(docPath, envPath, onDataCallback);
  }

  executeCode(
    docPath: string,
    code: string,
    _envPath: string,
    _blockId: string,
    onPartialOutput?: (output: CellOutput) => void,
  ) {
    // Use queue-based execution
    return this.manager.queueCodeExecution(docPath, code, onPartialOutput);
  }

  terminateExecution(docPath: string): void {
    this.manager.terminateExecution(docPath);
  }

  clearState(_docPath: string): void {
    this.manager.clearState();
  }

  disposeRunner(docPath: string): void {
    this.manager.disposeRunner(docPath);
  }

  disposeAll(): void {
    this.manager.disposeAll();
  }
}

// Registry for language runners
export class RunnerRegistry {
  private static instance: RunnerRegistry;
  private runners = new Map<string, ILanguageRunner>();

  private constructor() {
    // Register the Python runner by default
    const pythonAdapter = new PythonRunnerAdapter();
    this.runners.set("python", pythonAdapter);
  }

  static getInstance(): RunnerRegistry {
    if (!RunnerRegistry.instance) {
      RunnerRegistry.instance = new RunnerRegistry();
    }
    return RunnerRegistry.instance;
  }

  getRunner(language: string): ILanguageRunner | undefined {
    return this.runners.get(language.toLowerCase());
  }

  disposeAll(): void {
    for (const runner of this.runners.values()) {
      if ("disposeAll" in runner) {
        (runner as any).disposeAll();
      }
    }
    this.runners.clear();
  }
}
