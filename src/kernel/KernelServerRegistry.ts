import { CellOutput } from "../types";
import { PyKernelServer } from "./implementations/PyKernelServer";
import * as vscode from "vscode";

// Interface for language servers
export interface ILanguageServer {
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
  runSingleBlock?(
        context: vscode.ExtensionContext,
        docPath: string,
        code: string,
        position: number,
        bindingId: string,
        language: string): Promise<void>; // Optional for backward compatibility
}

// Registry for language servers
export class KernelServerRegistry {
  private static instance: KernelServerRegistry;
  private servers = new Map<string, ILanguageServer>();

  private constructor() {
    // Register the Python runner by default
    const pythonAdapter = new PyKernelServer();
    this.servers.set("python", pythonAdapter);
  }

  static getInstance(): KernelServerRegistry {
    if (!KernelServerRegistry.instance) {
      KernelServerRegistry.instance = new KernelServerRegistry();
    }
    return KernelServerRegistry.instance;
  }

  getRunner(language: string): ILanguageServer | undefined {
    return this.servers.get(language.toLowerCase());
  }

  disposeAll(): void {
    for (const server of this.servers.values()) {
      if ("disposeAll" in server) {
        (server as any).disposeAll();
      }
    }
    this.servers.clear();
  }
}
