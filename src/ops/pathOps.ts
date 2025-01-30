import * as vscode from "vscode";

export namespace pathOps {

  export function getDocPath(
    editor: vscode.TextEditor | undefined,
  ): string | undefined {
    if (!editor || editor.document.languageId !== "markdown") {
      return undefined;
    }
    return editor.document.uri.fsPath;
  }
}
