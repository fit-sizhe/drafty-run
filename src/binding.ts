import * as vscode from "vscode";
import { extractCodeBlocks, parseDraftyId } from "./codeBlockParser";
import { SessionState } from "./StateManager";
import { CodeBlock, CodeBlockExecution } from "./types";
import markdownit from 'markdown-it';


interface BellyGroupDocInfo {
    belly: string;
    firstPosition: number;
}

const CONFIG_SECTION = "drafty";
const ORPHAN_REMOVAL_KEY = "removeOrphanedBlocks";
const COMMENT_PREFIX: { [id: string]: string;} = {
    "javascript": "//",
    "js": "//",
    "python": "#",
    "lua": "--"
};

export function generateDraftyId(): string {
    const belly = Math.floor(Math.random() * 999).toString().padStart(3, "0");
    return `DRAFTY-ID-${belly}-0`;
}

export function getNextTailForSameBelly(
    sessionBlocks: Map<string, CodeBlockExecution>,
    belly: string
): number {
    let maxTail = -1;
    for (const block of sessionBlocks.values()) {
        const parsed = parseDraftyId(block.metadata?.bindingId || "");
        if (parsed?.belly === belly) {
            maxTail = Math.max(maxTail, parsed.tail);
        }
    }
    return maxTail + 1;
}

export async function ensureDraftyIdInCodeBlock(
    editor: vscode.TextEditor,
    range: vscode.Range
): Promise<string> {
    const document = editor.document;
    const code = document.getText(range);
    const block = extractCodeBlocksFromText(code)[0];

    // Use the parser's extracted binding ID if available
    const existingId = block?.bindingId?.head ? 
        `${block.bindingId.head}-${block.bindingId.belly}-${block.bindingId.tail}` :
        undefined;

    if (existingId) return existingId;

    // Generate and insert new ID if none found
    const newId = generateDraftyId();
    await editor.edit(editBuilder => {
        editBuilder.insert(
            new vscode.Position(range.start.line + 1, 0),
            `${COMMENT_PREFIX[block.language??"python"]}| ${newId}\n`
        );
    });
    return newId;
}

export async function syncAllBlockIds(
    doc: vscode.TextDocument,
    session: SessionState
): Promise<void> {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const removeOrphans = config.get<boolean>(ORPHAN_REMOVAL_KEY, false);

    // Extract code blocks from document using our parser
    const docBlocks = extractCodeBlocksFromDocument(doc);
    
    // Process document structure
    const { bellyGroups, docBlockMap } = processDocumentBlocks(docBlocks);
    
    // Reorganize session blocks based on document structure
    const { updatedBlocks } = reorganizeSessionBlocks(
        session.codeBlocks,
        bellyGroups,
        docBlockMap,
        removeOrphans
    );

    // Update session state
    session.codeBlocks = updatedBlocks;
    session.bellyGroups = bellyGroups.map((b)=> b.belly);
}

// Helper functions with clear responsibilities
function extractCodeBlocksFromText(text: string): CodeBlock[] {
    const md = markdownit();
    return extractCodeBlocks(md.parse(text, {}));
}

function extractCodeBlocksFromDocument(doc: vscode.TextDocument): CodeBlock[] {
    return extractCodeBlocksFromText(doc.getText());
}

function processDocumentBlocks(blocks: CodeBlock[]) {
    const bellyGroups: BellyGroupDocInfo[] = [];
    const seenBellies = new Set<string>();
    const docBlockMap: Map<string, CodeBlock> = new Map();

    // First pass: Identify all bellies and their first positions
    for (const block of blocks) {
        const belly = block.bindingId?.belly || "999";
        if (!seenBellies.has(belly)) {
            seenBellies.add(belly);
            bellyGroups.push({
                belly,
                firstPosition: block.position
            });
        }
    }

    // Sort belly groups by their first appearance in the document
    bellyGroups.sort((a, b) => a.firstPosition - b.firstPosition);

    // Second pass: Create ID sequence based on document order
    for (const block of blocks) {
        const belly = block.bindingId?.belly || "999";
        const tail = block.bindingId?.tail || 0;
        docBlockMap.set(`DRAFTY-ID-${belly}-${tail}`,block);
    }

    return { bellyGroups, docBlockMap };
}

function reorganizeSessionBlocks(
    existingBlocks: Map<string, CodeBlockExecution>,
    bellyGroups: BellyGroupDocInfo[],
    docBlockMap: Map<string, CodeBlock>,
    removeOrphans: boolean
) {
    const updatedBlocks = new Map<string, CodeBlockExecution>();
    const orphanedBlocks = new Map(existingBlocks);

    // 1. Add blocks in document order
    for (const bellyGroup of bellyGroups) {
        const groupBlocks = Array.from(existingBlocks.values())
            .filter(block => {
                const parsed = parseDraftyId(block.metadata?.bindingId || "");
                return parsed?.belly === bellyGroup.belly;
            })
            .sort((a, b) => {
                const aTail = parseDraftyId(a.metadata?.bindingId!)?.tail || 0;
                const bTail = parseDraftyId(b.metadata?.bindingId!)?.tail || 0;
                return aTail - bTail;
            });

        for (const block of groupBlocks) {
            if (block.metadata?.bindingId) {
                let updatedBlock = {...block, ...docBlockMap.get(block.metadata.bindingId)}
                updatedBlocks.set(block.metadata.bindingId, updatedBlock);
                orphanedBlocks.delete(block.metadata.bindingId);
            }
        }
    }

    // 2. Add remaining blocks (orphans) if configured to keep them
    if (!removeOrphans) {
        const orphans = Array.from(orphanedBlocks.values())
            .sort((a, b) => a.position - b.position);

        for (const block of orphans) {
            if (block.metadata?.bindingId) {
                updatedBlocks.set(block.metadata.bindingId, block);
            }
        }
    }

    // 3. Add new blocks from document that weren't in session
    for (const docId of docBlockMap.keys()) {
        if (!updatedBlocks.has(docId)) {
            const newBlock: CodeBlockExecution = {
                ...docBlockMap.get(docId),
                content: "",
                info: "",
                bindingId: parseDraftyId(docId),
                position: -1, // Will be updated during execution
                metadata: {
                    status: "pending",
                    timestamp: Date.now(),
                    bindingId: docId,
                },
                outputs: [],
            };
            updatedBlocks.set(docId, newBlock);
        }
    }

    return { updatedBlocks };
}
