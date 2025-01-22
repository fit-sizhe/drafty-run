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

interface BellyGroupDocInfo {
  belly: string;
  firstPosition: number; // where we first saw this belly
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
 * Scans the entire markdown doc, extracts code blocks, and ensures each has a valid DRAFTY-ID.
 * Then reorders all blocks in session.state according to:
 *   1) the order of "belly groups" as they appear in the doc (the first time that belly is found),
 *   2) ascending tail within each belly group,
 *   3) optionally merges or discards orphan belly groups (those not in the doc).
 */
export async function syncAllBlockIds(
  doc: vscode.TextDocument,
  session: SessionState
): Promise<void> {
  // Gather user config to see if we remove or keep orphans
  const config = vscode.workspace.getConfiguration("drafty");
  const removeOrphanedBlocks: boolean = config.get<boolean>("removeOrphanedBlocks", false);

  const markdown = doc.getText();
  const tokens = parseMarkdownContent(markdown);
  const codeBlocks = extractCodeBlocks(tokens);

  /************************************************
   * Identify the belly group order in the doc
   ************************************************/
  
  const bellyGroupsInDoc: BellyGroupDocInfo[] = [];
  const seenBellySet = new Set<string>(); // track distinct belly values

  const docBlocksInfo: {
    belly: string;
    tail: number;
    bindingId: string;
    position: number;
  }[] = [];

  // For each code block in the doc, find or generate its bindingId
  for (const block of codeBlocks) {
    let foundId: string | undefined;
    // naive approach: look for a line that matches DRAFTY-ID
    const lines = block.content.split(/\r?\n/);
    for (const line of lines) {
      const maybeId = line.replace(/^#\|\s*/, "").trim();
      if (parseDraftyId(maybeId)) {
        foundId = maybeId;
        break;
      }
    }
    if (!foundId) {
      // this line should never be called due the call in 
      // runBlockHandler
      // keep it here for debugging purpose
      foundId = generateDraftyId();
    }

    const { belly, tail } = parseBellyTail(foundId);
    docBlocksInfo.push({ belly, tail, bindingId: foundId, position: block.position });

    // If we haven't seen this belly yet, record it with its first position
    if (!seenBellySet.has(belly)) {
      seenBellySet.add(belly);
      bellyGroupsInDoc.push({ belly, firstPosition: block.position });
    }
  }

  // Sort the doc's belly groups by the first position we saw them
  bellyGroupsInDoc.sort((a, b) => a.firstPosition - b.firstPosition);

  // docBlocksInfo sorted top-to-bottom
  docBlocksInfo.sort((a, b) => a.position - b.position);

  /************************************************
   * Convert session.codeBlocks -> grouped data
   ************************************************/
  const oldMap = session.codeBlocks;
  // belly -> CodeBlockExecution[]
  const sessionGroups = new Map<string, CodeBlockExecution[]>();

  for (const [_, codeBlock] of oldMap.entries()) {
    const blockId = codeBlock.metadata?.bindingId;
    // store "no-id"  and malformed-id blocks in group "999"
    let groupBelly = "999"
    if (blockId) {
      const parsed = parseDraftyId(blockId);
      if (parsed) groupBelly = parsed.belly;
    }
    
    if (!sessionGroups.has(groupBelly)) {
      sessionGroups.set(groupBelly, []);
    }
    sessionGroups.get(groupBelly)!.push(codeBlock);
  }

  // Sort each belly group by ascending tail
  for (const [belly, blocks] of sessionGroups) {
    if(belly === "999") {
      blocks.sort((a,b) => {
        return a.position - b.position
      })
    } else { 
      blocks.sort((a, b) => {
        const aId = parseDraftyId(a.metadata?.bindingId || "");
        const bId = parseDraftyId(b.metadata?.bindingId || "");
        if (!aId || !bId) return 0;
        return aId.tail - bId.tail;
      });
    }
  }

  /************************************************
   * Merge doc blocks into session groups
   ************************************************/
  for (const db of docBlocksInfo) {
    const groupBelly = db.belly;
    if (!sessionGroups.has(groupBelly)) {
      sessionGroups.set(groupBelly, []);
    }
    const group = sessionGroups.get(groupBelly)!;
    // Check if we already have a block with bindingId == db.bindingId
    const existing = group.find(g => g.metadata?.bindingId === db.bindingId);
    if (!existing) {
      // Create a new "pending" block
      const newBlock: CodeBlockExecution = {
        content: "", // You could store actual code from doc if you want
        info: "",
        position: db.position,
        metadata: {
          status: "pending",
          timestamp: Date.now(),
          bindingId: db.bindingId,
        },
        outputs: [],
      };
      group.push(newBlock);
      // Re-sort by tail after adding
      group.sort((a, b) => {
        const aId = parseDraftyId(a.metadata?.bindingId || "");
        const bId = parseDraftyId(b.metadata?.bindingId || "");
        if (!aId || !bId) return 0;
        return aId.tail - bId.tail;
      });
    }
  }

  /************************************************
   * Build newMap in doc belly order, then orphans
   ************************************************/
  const newMap = new Map<string, CodeBlockExecution>();

  // Insert doc belly groups in the doc's order
  for (const groupInfo of bellyGroupsInDoc) {
    const belly = groupInfo.belly;
    const blocks = sessionGroups.get(belly);
    if (!blocks) {
      continue;
    }
    // Already sorted by tail
    for (const block of blocks) {
      const id = block.metadata?.bindingId;
      if (id) {
        newMap.set(id, block);
      }
    }
    // Mark we've handled this belly
    sessionGroups.delete(belly);
  }

  // handle orphan belly groups (those not in the doc)
  // either remove them or keep them after the doc groups
  for (const [belly, blocks] of sessionGroups) {
    if (seenBellySet.has(belly)) {
      // already handled these in doc order
      // skip
      continue;
    }

    // If `removeOrphanedBlocks` is true, skip them
    if (removeOrphanedBlocks) {
      continue;
    }

    // Otherwise, keep them at the bottom
    for (const block of blocks) {
      const id = block.metadata?.bindingId;
      if (id) {
        newMap.set(id, block);
      }
    }
  }

  session.codeBlocks = newMap;
}
