import * as vscode from "vscode";
import * as path from "path";

export namespace pathUtils {

  export function getDocPath(
    editor: vscode.TextEditor | undefined,
  ): string | undefined {
    if (!editor || editor.document.languageId !== "markdown") {
      return undefined;
    }
    return editor.document.uri.fsPath;
  }
}
