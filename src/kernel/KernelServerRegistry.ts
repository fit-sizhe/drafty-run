import { CellOutput, CodeBlockExecution } from "../types";
import { PyKernelServer } from "./implementations/PyKernelServer";
import * as vscode from "vscode";

// Interface for language servers
export interface ILanguageServer {
  executeCode(
    docPath: string,
    code: string,
    onPartialOutput?: (output: CellOutput) => void,
  ): Promise<{ outputs: CellOutput[] }>;
  // "soft"? clear global status of runner class
  clearState(docPath: string): void;
  // remove server
  disposeServer(docPath: string): void;
  // start a background process for specific doc
  startProcessForDoc(
    docPath: string,
    envPath: string): void;
  // interrupt execution, not kill
  terminateExecution(docPath: string): void;
  // relay execution result to webview 
  // this is where "onPartialOutput" gets defined
  runSingleBlock(
        docPath: string,
        code: string,
        blockState: CodeBlockExecution,
        panel?: vscode.WebviewPanel): Promise<void>; // being called in commands.ts
  // relay execution result to webview for interactive plot init
  runDirectiveInit(
    docPath: string,
    code: string,
    blockState: CodeBlockExecution,
    panel?: vscode.WebviewPanel
  ): Promise<void>;
  // relay execution result to webview for interactive plot updates
  runDirectiveUpdate(
    docPath: string,
    drafty_id: string,
    updates: Map<string, number | string>,
    panel?: vscode.WebviewPanel
  ): Promise<void>;
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
