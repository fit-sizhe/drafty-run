import * as vscode from "vscode";
import { parseMarkdownContent, extractCodeBlocks } from "./codeBlockParser";
import { SessionState } from "./state_io";
import { CodeBlockExecution } from "./types";

/**
 * Matches something like:  DRAFTY-ID-123-4
 *    group1: DRAFTY-ID
 *    group2: 3-digit
 *    group3: single digit
 */
const DRAFTY_ID_REGEX = /^(DRAFTY-ID)-(\d{3})-(\d)$/;

interface DraftyIdParts {
  head: string; // e.g. "DRAFTY-ID"
  belly: string; // e.g. "123"
  tail: number; // e.g. 4
}

/** Parse a full "DRAFTY-ID-xxx-y" into its parts, if valid. */
export function parseDraftyId(str: string): DraftyIdParts | undefined {
  const match = DRAFTY_ID_REGEX.exec(str.trim());
  if (!match) return undefined;
  return {
    head: match[1],
    belly: match[2],
    tail: parseInt(match[3], 10),
  };
}

/**
 * Generate a brand-new DRAFTY-ID.
 * By default, we set belly = random 3-digit, tail=0.
 */
export function generateDraftyId(): string {
  const belly = Math.floor(Math.random() * 999)
    .toString()
    .padStart(3, "0");
  // always start with tail=0 when brand-new
  return `DRAFTY-ID-${belly}-0`;
}

/**
 * Given a block's bindingId, find the next tail if you already have
 * existing blocks with the same head+belly but different tails.
 */
export function getNextTailForSameBelly(
  sessionBlocks: Map<string, any>,
  head: string,
  belly: string,
): number {
  let maxTail = -1;
  for (const [_key, block] of sessionBlocks.entries()) {
    if (!block.metadata || !block.metadata.bindingId) continue;
    const parts = parseDraftyId(block.metadata.bindingId);
    if (!parts) continue;
    // same "head" and "belly"
    if (parts.head === head && parts.belly === belly) {
      maxTail = Math.max(maxTail, parts.tail);
    }
  }
  return maxTail + 1; // next available tail
}

/**
 * Reads the markdown lines for the selected `range`,
 * looks for a "DRAFTY-ID-xxx-y" pattern. If not found,
 * inserts a comment line at the end of the code block.
 *
 * Returns the existing or newly generated ID string.
 */
export function ensureDraftyIdInCodeBlock(
  editor: vscode.TextEditor,
  range: vscode.Range,
): string {
  const document = editor.document;
  let code = document.getText(range);
  // We'll split lines and see if there's a line that matches the DRAFTY-ID pattern.
  const lines = code.split(/\r?\n/);

  let existingId: string | undefined;
  for (const line of lines) {
    const maybeParts = parseDraftyId(line.replace(/^#\|\s*/, ""));
    if (maybeParts) {
      existingId = line.replace(/^#\|\s*/, "").trim();
      break;
    }
  }

  if (existingId) {
    // We already have an ID
    return existingId;
  }

  // Otherwise, generate a new one
  const newId = generateDraftyId();

  // Insert "#| DRAFTY-ID-xxx-0" as a new line right beneath the top fence
  const firstLine = range.start.line + 1;
  editor.edit((editBuilder) => {
    const insertionPos = new vscode.Position(firstLine, 0);
    editBuilder.insert(insertionPos, `#| ${newId}\n`);
  });

  return newId;
}

/**
 * Scans the entire markdown doc for code blocks.
 * If any block has a `# DRAFTY-ID-xxx-y` comment, reuse that;
 * if not, generate a new ID. Then reorder session's codeBlocks
 * so that they match the doc’s block order. 
 */
export async function syncAllBlockIds(
  doc: vscode.TextDocument,
  session: SessionState
): Promise<void> {
  // Parse doc blocks
  const markdown = doc.getText();
  const tokens = parseMarkdownContent(markdown);
  const codeBlocks = extractCodeBlocks(tokens);

  // For each extracted code block, ensure we have a bindingId
  const docEntries: { bindingId: string; position: number }[] = [];
  for (const block of codeBlocks) {
    let foundId: string | undefined;
    const lines = block.content.split(/\r?\n/);
    for (const line of lines) {
      const maybeId = line.replace(/^#\|\s*/, "").trim(); // or just /^#\s*/ 
      if (parseDraftyId(maybeId)) {
        foundId = maybeId;
        break;
      }
    }
    if (!foundId) {
      foundId = generateDraftyId();
    }
    docEntries.push({ bindingId: foundId, position: block.position });
  }

  docEntries.sort((a, b) => a.position - b.position);

  const oldMap = session.codeBlocks;
  const newMap = new Map<string, CodeBlockExecution>();

  // Insert or reuse doc-based IDs
  for (const { bindingId, position } of docEntries) {
    let existingResult = oldMap.get(bindingId);

    if (existingResult) {
      newMap.set(bindingId, existingResult);
    } else {
      // create a new block if none existed
      newMap.set(bindingId, {
        content: "",
        info: "",
        position,
        metadata: {
          status: "pending",
          timestamp: Date.now(),
          bindingId,
        },
        outputs: [],
      });
    }
  }

  // Merge in old IDs that are NOT found in the doc
  for (const [_, oldBlock] of oldMap) {
    const oldId = oldBlock?.metadata?.bindingId;
    if (oldId && !newMap.has(oldId)) {
      newMap.set(oldId, oldBlock);
    }
  }

  session.codeBlocks = newMap;
}
