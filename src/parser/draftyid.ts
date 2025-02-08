import { BARE_DRAFTYID_PATTERN, BINDINGID_PATTERN } from "./regex";

export interface DraftyIdParts {
  head: string; // e.g. "DRAFTY-ID"
  belly: string; // e.g. "123"
  tail: number; // e.g. 4
}

export function parseDraftyId(str: string): DraftyIdParts | undefined {
  let match: RegExpExecArray | null;
  if (!str.includes("|")) {
    match = BARE_DRAFTYID_PATTERN.exec(str.trim());
  } else {
    match = BINDINGID_PATTERN.exec(str.trim());
  }
  if (!match) return undefined;
  return {
    head: "DRAFTY-ID",
    belly: str.includes("|") ? match[3] : match[2],
    tail: parseInt(str.includes("|") ? match[4] : match[3], 10),
  };
}

/**
 * Parse "belly" and "tail" directly from a code block's DRAFTY-ID comment line.
 * If not found or invalid, returns { belly: "000", tail: 0 } or something similar.
 */
export function parseBellyTail(bindingId: string): {
  belly: string;
  tail: number;
} {
  const parsed = parseDraftyId(bindingId);
  if (!parsed) {
    // fallback if invalid
    return { belly: "000", tail: 0 };
  }
  return { belly: parsed.belly, tail: parsed.tail };
}
