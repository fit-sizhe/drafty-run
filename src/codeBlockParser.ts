import * as vscode from "vscode";
import markdownit from "markdown-it";
import { Token } from "markdown-it";
import { CodeBlock } from "./types";

// Language-agnostic comment patterns
const TITLE_PATTERN = /^\s*([#/]{1,2}|--)\s*\|\s*title:\s*(.+)$/m;
const BINDINGID_PATTERN = /^\s*([#/]{1,2}|--)\s*\|\s*(DRAFTY-ID)-(\d{3})-(\d)$/m;
const BARE_DRAFTYID_PATTERN = /^(DRAFTY-ID)-(\d{3})-(\d)$/;

interface DraftyIdParts {
  head: string; // e.g. "DRAFTY-ID"
  belly: string; // e.g. "123"
  tail: number; // e.g. 4
}

type Input = {
  param: string
}

type Slider = {
  param: string,
  min: number,
  max: number
}

interface Directives {
  execute: string,
  controls: (Input | Slider)[]
}

export function parseDraftyId(str: string): DraftyIdParts | undefined {
  let match: RegExpExecArray | null;
  if(!str.includes('|')){
    match = BARE_DRAFTYID_PATTERN.exec(str.trim());
  } else {
    match = BINDINGID_PATTERN.exec(str.trim());
  }
  if (!match) return undefined;
  return {
    head: 'DRAFTY-ID',
    belly: str.includes('|')?match[3]:match[2],
    tail: parseInt(str.includes('|')?match[4]:match[3], 10),
  };
}

/**
 * Parse "belly" and "tail" directly from a code block's DRAFTY-ID comment line.
 * If not found or invalid, returns { belly: "000", tail: 0 } or something similar.
 */
export function parseBellyTail(bindingId: string): { belly: string; tail: number } {
  const parsed = parseDraftyId(bindingId);
  if (!parsed) {
    // fallback if invalid
    return { belly: "000", tail: 0 };
  }
  return { belly: parsed.belly, tail: parsed.tail };
}

// TODO: parse special directives in code blocks for plotting interactive plots
export function parseDirectives(code: string): Directives | undefined {
  return;
}

export function extractCodeBlocks(tokens: Token[]): CodeBlock[] {
  return tokens
    .filter(t => t.type === "fence" && t.map)
    .map(token => {
      const language = token.info.trim().toLowerCase();
      let title: string | undefined;
      let bindingId: undefined | DraftyIdParts;
      
      const titlematch = token.content.match(TITLE_PATTERN);
      title = titlematch?.[2]?.trim();
      const idmatch = token.content.match(BINDINGID_PATTERN);
      if (idmatch) {
        bindingId = {
          head: idmatch[2],
          belly: idmatch[3],
          tail: parseInt(idmatch[4], 10),
        };
      }

      return {
        content: token.content,
        info: token.info.trim(),
        position: token.map![0],
        title,
        language,
        bindingId
      };
    });
}

export function parseMarkdownContent(content: string): Token[] {
  const md = markdownit();
  return md.parse(content, {});
}

export function extractCodeFromRange(
  document: vscode.TextDocument,
  range: vscode.Range,
): string {
  if(range.end.line-range.start.line<=1) return "";
  let code = document.getText(range);
  return code.replace(/^```[\w\-]*\s*|```$/gm, "");
}

export function findMetaForRange(
  document: vscode.TextDocument,
  range: vscode.Range,
): {
  code: string, 
  language: string | undefined, 
  title: string | undefined
} {
  const text = document.getText(range)
  const md = markdownit();
  const tokens = md.parse(text, {});
  const { language, title } = extractCodeBlocks(tokens)[0];

  return {
    code: text.replace(/^```[\w\-]*\s*|```$/gm, ""),
    language, title 
  };
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
