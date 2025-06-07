import * as vscode from "vscode";
import markdownit from "markdown-it";
import { Token } from "markdown-it";
import { CodeBlock } from "../types";
import { DraftyIdParts } from "./draftyid";
import { TITLE_PATTERN, BINDINGID_PATTERN, STREAM_PATTERN } from "./regex";

export function extractCodeBlocks(text: Token[] | string): CodeBlock[] {
  let tokens: Token[];
  if (typeof text == "string") {
    const md = markdownit();
    tokens = md.parse(text, {});
  } else tokens = text;

  return tokens
    .filter((t) => t.type === "fence" && t.map)
    .map((token) => {
      const language = token.info.trim().toLowerCase();
      let title: string | undefined;
      let bindingId: undefined | DraftyIdParts;
      let stream: boolean | undefined;

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
      
      const streamMatch = token.content.match(STREAM_PATTERN);
      if (streamMatch) {
        stream = streamMatch[2].toLowerCase() === 'true';
      }

      return {
        content: token.content,
        info: token.info.trim(),
        position: token.map![0],
        title,
        language,
        stream,
        bindingId,
      };
    });
}

export function parseMarkdownContent(content: string): Token[] {
  const md = markdownit();
  return md.parse(content, {});
}

export function extractCodeFromRange(
  document: vscode.TextDocument,
  range: vscode.Range
): string {
  if (range.end.line - range.start.line <= 1) return "";
  let code = document.getText(range);
  return code.replace(/^```[\w\-]*\s*|```$/gm, "");
}

export function findMetaForRange(
  document: vscode.TextDocument,
  range: vscode.Range
): {
  code: string;
  language: string | undefined;
  title: string | undefined;
  stream: boolean | undefined;
} {
  const text = document.getText(range);
  const md = markdownit();
  const tokens = md.parse(text, {});
  const { language, title, stream } = extractCodeBlocks(tokens)[0];

  return {
    code: text.replace(/^```[\w\-]*\s*|```$/gm, ""),
    language,
    title,
    stream,
  };
}
