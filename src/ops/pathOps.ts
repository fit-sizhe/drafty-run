import * as vscode from "vscode";

export namespace pathOps {
  const docDefaultPaths = new Map<string, string>();

  export function setDefaultPathForDoc(docPath: string, newFolder: string) {
    docDefaultPaths.set(docPath, newFolder);
  }

  export function getDefaultPathForDoc(docPath: string): string | undefined {
    return docDefaultPaths.get(docPath);
  }

  export function getDocPath(
    editor: vscode.TextEditor | undefined,
  ): string | undefined {
    if (!editor || editor.document.languageId !== "markdown") {
      return undefined;
    }
    return editor.document.uri.fsPath;
  }
}
