import * as vscode from "vscode";
import markdownit from "markdown-it";
import { CodeBlock } from "./types";

// Language-specific comment patterns
const TITLE_COMMENT_PATTERNS = new Map<string, RegExp>([
  ['python', /^#\|\s*title:\s*(.+)$/m],
  ['javascript', /^\/\/\|\s*title:\s*(.+)$/m],
]);

const BINDINGID_COMMENT_PATTERNS = new Map<string, RegExp>([
  ['python', /^#\|\s+(DRAFTY-ID)-(\d{3})-(\d)$/m],
  ['javascript', /^\/\/\|\s+(DRAFTY-ID)-(\d{3})-(\d)$/m],
]);


export function extractCodeBlocks(tokens: any[]): CodeBlock[] {
  return tokens
    .filter(t => t.type === "fence" && t.map)
    .map(token => {
      const language = token.info.trim().toLowerCase();
      const titleRegex = TITLE_COMMENT_PATTERNS.get(language);
      const bindingIdRegex = BINDINGID_COMMENT_PATTERNS.get(language);
      let title: string | undefined;
      let bindingId: undefined | {
        head: string;
        belly: string; 
        tail: number; 
      };
      
      if (titleRegex) {
        const match = token.content.match(titleRegex);
        title = match?.[1]?.trim();
      }
      if (bindingIdRegex){
        const match = token.content.match(bindingIdRegex);
        if (match) {
          bindingId = {
            head: match[1],
            belly: match[2],
            tail: parseInt(match[3], 10),
          };
        }
      }

      return {
        content: token.content,
        info: token.info.trim(),
        position: token.map[0],
        title,
        language,
        bindingId
      };
    });
}

export function parseMarkdownContent(content: string): any[] {
  const md = markdownit();
  return md.parse(content, {});
}

export function extractCodeFromRange(
  document: vscode.TextDocument,
  range: vscode.Range,
): string {
  let code = document.getText(range);
  return code.replace(/^```[\w\-]*\s*|```$/gm, "");
}

export function findLanguageForRange(
  document: vscode.TextDocument,
  range: vscode.Range,
): string {
  const text = document.getText();
  const md = markdownit();
  const tokens = md.parse(text, {});

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === "fence" && t.map) {
      const [startLine, endLine] = t.map;
      if (startLine === range.start.line && endLine === range.end.line + 1) {
        return t.info.trim();
      }
    }
  }
  return "";
}
