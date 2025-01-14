import * as vscode from "vscode";
import { parseMarkdownContent } from "./codeBlockParser";

export class MarkdownCodeLensProvider implements vscode.CodeLensProvider {
  public provideCodeLenses(
    document: vscode.TextDocument,
    _token: vscode.CancellationToken,
  ): vscode.CodeLens[] {
    const codeLenses: vscode.CodeLens[] = [];
    const text = document.getText();
    const tokens = parseMarkdownContent(text);

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token.type === "fence" && token.map) {
        const [startLine, endLine] = token.map; // endLine is exclusive
        const range = new vscode.Range(startLine, 0, endLine - 1, 0);

        // 1) Run code block
        const runCmd: vscode.Command = {
          title: "▶ Run Code Block",
          command: "drafty.runBlock",
          arguments: [range],
        };
        codeLenses.push(new vscode.CodeLens(range, runCmd));

        // 2) Terminate code block
        const termCmd: vscode.Command = {
          title: "✖ Terminate Execution",
          command: "drafty.terminateBlock",
          arguments: [range],
        };
        codeLenses.push(new vscode.CodeLens(range, termCmd));
      }
    }
    return codeLenses;
  }
}
