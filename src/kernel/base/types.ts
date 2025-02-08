// src/kernel/base/types.ts
import { CellOutput } from "../../types";

export interface ExecutionResult {
  outputs: CellOutput[];
}

export interface JupyterMessage {
  header: {
    msg_id: string;
    msg_type: string;
    [key: string]: any;
  };
  parent_header?: {
    msg_id: string;
  };
  content: any;
}

export interface JupyterWidget {
  id: string;
  // not used currently
}
