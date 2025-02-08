import { ExecutionResult, JupyterWidget } from "./types";

export abstract class BaseKernel {
  abstract start(pythonPath: string, cwd: string): Promise<void>;
  abstract stop(): Promise<void>;
  abstract execute(code: string): Promise<ExecutionResult>;
  abstract interrupt(): Promise<void>;

}
