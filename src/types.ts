export interface BaseOutput {
  type: string;
  timestamp: number;
}

export interface TextOutput extends BaseOutput {
  type: "text";
  content: string;
  stream: "stdout" | "stderr";
}

export interface ImageOutput extends BaseOutput {
  type: "image";
  format: "png" | "jpeg" | "svg";
  data: string;
  metadata?: {
    width?: number;
    height?: number;
  };
}

export interface ErrorOutput extends BaseOutput {
  type: "error";
  error: string;
  traceback?: string[];
}

export interface RichOutput extends BaseOutput {
  type: "rich";
  format: "html" | "latex";
  content: string;
}

export type CellOutput = TextOutput | ImageOutput | ErrorOutput | RichOutput;

export interface CodeBlock {
  content: string;
  info: string;
  position: number; // Line number in document where block starts
  title?: string;
  language?: string;
  bindingId?: {
    head: string; // e.g. "DRAFTY-ID"
    belly: string; // e.g. "123"
    tail: number; // e.g. 4
  }
}

export interface ExecutionState {
  running: boolean;
  startTime?: number;
  endTime?: number;
  success?: boolean;
}

export interface ExecutionMetadata {
  executionTime?: number;
  status: "pending" | "running" | "success" | "error";
  timestamp: number;
  bindingId?: string;
  runNumber?: number;
  title?: string;
}

export interface CodeBlockExecution extends CodeBlock {
  metadata: ExecutionMetadata;
  outputs: CellOutput[];
}
