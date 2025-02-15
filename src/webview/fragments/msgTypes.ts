import { CellOutput } from "../../types";

/**
 * Common base for any message interface.
 */
export interface IMessageBase {
  command: string;
}

// ------------------
// Webview → Extension messages
// ------------------

export interface IDebugMessage extends IMessageBase {
  command: "debug";
  [id:string]: any;
}

export interface IChangeEnvMessage extends IMessageBase {
  command: "changeEnv";
  pythonPath: string;
}

export interface IChangeMaxHeightMessage extends IMessageBase {
  command: "changeMaxHeight";
  value: number;
}

export interface IClearStateMessage extends IMessageBase {
  command: "clearState";
}

export interface IRefreshEnvMessage extends IMessageBase {
  command: "refreshEnv";
}

export interface ILoadResultsMessage extends IMessageBase {
  command: "loadResults";
}

export interface ISaveAsMessage extends IMessageBase {
  command: "saveAs";
}

export interface ISaveMessage extends IMessageBase {
  command: "save";
}

export interface IRunDirectiveUpdateMessage extends IMessageBase {
  command: "runDirectiveUpdate";
  msg: {
    drafty_id: string;
    param: string;
    current: string | number;
  };
}

/**
 * Union of messages the webview sends OUT to the extension.
 */
export type OutboundWebviewMessage =
  | IDebugMessage
  | IChangeEnvMessage
  | IChangeMaxHeightMessage
  | IClearStateMessage
  | IRefreshEnvMessage
  | ILoadResultsMessage
  | ISaveAsMessage
  | ISaveMessage
  | IRunDirectiveUpdateMessage;

// ------------------
// Extension → Webview messages
// ------------------

/**
 * For partial output, define subtypes of "output"
 * that your extension might send to the webview.
 */
export type OutputType = CellOutput

export interface IReorderBlocksMessage extends IMessageBase {
  command: "reorderBlocks";
  order: string[];
  focusedId?: string;
  rmOrphaned?: boolean;
}

export interface IUpdateBlockStatusMessage extends IMessageBase {
  command: "updateBlockStatus";
  containerId: string;
  status: "pending" | "running" | "success";
  runNum?: number;
  clearContent?: boolean;
  title?: string;
  executionTime?: number;
}

export interface IUpdateEnvOptionsMessage extends IMessageBase {
  command: "updateEnvOptions";
  envs: Array<{ path: string; label: string }>;
  selected: string;
}

export interface IUpdateLoadedPathMessage extends IMessageBase {
  command: "updateLoadedPath";
  path?: string;
}

export interface IPartialOutputMessage extends IMessageBase {
  command: "partialOutput";
  blockId: string;
  output: OutputType;
}

export interface IScrollToBlockMessage extends IMessageBase {
  command: "scrollToBlock";
  blockId: string;
}

export interface IClearBodyMessage extends IMessageBase {
  command: "clearBody";
}

/**
 * Union of messages the extension sends IN to the webview.
 */
export type InboundExtensionMessage =
  | IReorderBlocksMessage
  | IUpdateBlockStatusMessage
  | IUpdateEnvOptionsMessage
  | IUpdateLoadedPathMessage
  | IPartialOutputMessage
  | IScrollToBlockMessage
  | IClearBodyMessage;

/**
 * Combined union of *all* known inbound messages from extension.
 */
export type InboundMessage = InboundExtensionMessage;
