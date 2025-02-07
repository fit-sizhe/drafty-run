import * as vscode from "vscode";
import markdownit from "markdown-it";
import { Token } from "markdown-it";
import { CodeBlock } from "./types";

// Language-agnostic meta comment patterns
const TITLE_PATTERN = /^\s*([#/]{1,2}|--)\s*\|\s*title:\s*(.+)$/m;
const BINDINGID_PATTERN =
  /^\s*([#/]{1,2}|--)\s*\|\s*(DRAFTY-ID)-(\d{3})-(\d)$/m;
const BARE_DRAFTYID_PATTERN = /^(DRAFTY-ID)-(\d{3})-(\d)$/;

interface DraftyIdParts {
  head: string; // e.g. "DRAFTY-ID"
  belly: string; // e.g. "123"
  tail: number; // e.g. 4
}

// Basic types for the interactive plot configuration
type Input = {
  param: string;
  type: "number" | "options";
  options?: string[];
};

type Slider = {
  param: string;
  min: number;
  max: number;
  step?: number;
};

type PlotExec = {
  plot_type: "surface" | "scatter" | "curve";
  command: string;
};

interface Directives {
  execute: PlotExec[]; // one plot -> multiple plot exec
  controls: (Input | Slider)[]; // one plot -> multiple controls
}

export interface ParseError {
  /** 1-indexed line number where the error was found */
  line: number;
  /** The raw directive string (excluding "#|") */
  directive: string;
  /** A descriptive error message */
  message: string;
}

/** Overall result from parsing: both the directives (if any) and all errors encountered. */
export interface ParseResult {
  directives?: Directives;
  errors: ParseError[];
}

/** Result type for slider parsing */
interface SliderParseResult {
  sliders?: Slider[];
  errors: ParseError[];
}

/** Result type for input parsing */
interface InputParseResult {
  inputs?: Input[];
  errors: ParseError[];
}

/** Result type for plot parsing */
interface PlotParseResult {
  plot?: PlotExec;
  errors: ParseError[];
}

/**
 * Parses a string containing directives and returns a ParseResult with any directives
 * found and an array of errors (if any).
 *
 * @param code The full source code (or fenced code block) to parse.
 * @returns A ParseResult containing directives (if found) and errors.
 */
export function parseDirectivesFromStr(code: string): ParseResult {
  const lines = code.split("\n");
  const directives: Directives = { execute: [], controls: [] };
  const errors: ParseError[] = [];
  let hasDirectives = false;

  for (let i = 0; i < lines.length; i++) {
    const trimmedLine = lines[i].trim();
    if (trimmedLine.startsWith("#|")) {
      hasDirectives = true;
      const directiveText = trimmedLine.substring(2).trim();

      // Slider directive
      if (directiveText.startsWith("slider:")) {
        const sliderResult = parseSliderDirective(
          directiveText.substring(7).trim(),
          i + 1
        );
        if (sliderResult.sliders) {
          directives.controls.push(...sliderResult.sliders);
        }
        errors.push(...sliderResult.errors);

        // Input directive (accepts both colon and semicolon)
      } else if (
        directiveText.startsWith("input:") ||
        directiveText.startsWith("input;")
      ) {
        const inputResult = parseInputDirective(
          directiveText.substring(6).trim(),
          i + 1
        );
        if (inputResult.inputs) {
          directives.controls.push(...inputResult.inputs);
        }
        errors.push(...inputResult.errors);

        // Plot directives: surface, scatter, curve
      } else if (
        directiveText.startsWith("surface:") ||
        directiveText.startsWith("scatter:") ||
        directiveText.startsWith("curve:")
      ) {
        const colonIdx = directiveText.indexOf(":");
        const plotType = directiveText.substring(0, colonIdx).trim();
        const plotResult = parsePlotDirective(
          directiveText.substring(colonIdx + 1).trim(),
          plotType,
          i + 1
        );
        if (plotResult.plot) {
          directives.execute.push(plotResult.plot);
        }
        errors.push(...plotResult.errors);
      } else {
        // Unknown directive type
        errors.push({
          line: i + 1,
          directive: directiveText,
          message: "Unknown directive type.",
        });
      }
    }
  }

  return {
    directives: hasDirectives ? directives : undefined,
    errors,
  };
}

/**
 * Parses a slider directive string.
 * Examples:
 *   "#| slider: a, 1, 5"  → creates one slider for parameter "a"
 *   "#| slider: [a,b,c], 1, 5, 1" → creates one slider for each of a, b, and c.
 *
 * @param directive The directive string (without the "slider:" keyword).
 * @param line The line number where this directive appears.
 * @returns A SliderParseResult with parsed sliders and any errors.
 */
function parseSliderDirective(
  directive: string,
  line: number
): SliderParseResult {
  const result: SliderParseResult = { errors: [] };

  // Split by commas and remove any empty parts (tolerates extra/trailing commas)
  const parts = directive
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (parts.length < 3) {
    result.errors.push({
      line,
      directive,
      message: "Slider directive must have at least 3 parts (param, min, max).",
    });
    return result;
  }

  const paramPart = parts[0];
  const minStr = parts[1];
  const maxStr = parts[2];
  const stepStr = parts[3]; // optional

  const min = parseFloat(minStr);
  const max = parseFloat(maxStr);
  if (isNaN(min) || isNaN(max)) {
    result.errors.push({
      line,
      directive,
      message: "Invalid min or max value in slider directive.",
    });
    return result;
  }

  let step: number | undefined = undefined;
  if (stepStr !== undefined) {
    const s = parseFloat(stepStr);
    if (!isNaN(s)) {
      step = s;
    } else {
      result.errors.push({
        line,
        directive,
        message: "Invalid step value in slider directive.",
      });
    }
  }

  // Remove surrounding brackets (if any) then split by comma to support multiple controls
  const params = paramPart
    .replace(/[\[\]]/g, "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s);
  if (params.length === 0) {
    result.errors.push({
      line,
      directive,
      message: "No parameter specified in slider directive.",
    });
    return result;
  }

  result.sliders = [];
  for (const param of params) {
    result.sliders.push({
      param,
      min,
      max,
      step,
    });
  }
  return result;
}

/**
 * Parses an input directive string.
 * Examples:
 *   "#| input: a" → a number input for "a".
 *   "#| input: [a,b]" → number inputs for both "a" and "b".
 *   "#| input: b, ['opt1', 'opt2', c]" → options input for "b".
 *   "#| input; [a,b], ['opt1','opt2']" → options inputs for both "a" and "b".
 *
 * @param directive The directive string (without the "input:" or "input;" keyword).
 * @param line The line number where this directive appears.
 * @returns An InputParseResult with parsed inputs and any errors.
 */
function parseInputDirective(
  directive: string,
  line: number
): InputParseResult {
  const result: InputParseResult = { errors: [] };
  let paramPart = directive;
  let optionsPart = "";

  // Only split on the first comma (since optionsPart may itself contain commas)
  const commaIndex = directive.indexOf(",");
  if (commaIndex !== -1) {
    paramPart = directive.substring(0, commaIndex).trim();
    optionsPart = directive.substring(commaIndex + 1).trim();
  }

  // Allow a list of parameters if enclosed in brackets
  const params = paramPart
    .replace(/[\[\]]/g, "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s);
  if (params.length === 0) {
    result.errors.push({
      line,
      directive,
      message: "No parameter specified in input directive.",
    });
    return result;
  }

  result.inputs = [];
  if (optionsPart) {
    // If the options part is bracketed, use a simple custom parser.
    if (optionsPart.startsWith("[") && optionsPart.endsWith("]")) {
      const inner = optionsPart.substring(1, optionsPart.length - 1);
      const opts = inner
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s);
      const cleanedOpts = opts.map((opt) => {
        if (
          (opt.startsWith("'") && opt.endsWith("'")) ||
          (opt.startsWith('"') && opt.endsWith('"'))
        ) {
          return opt.substring(1, opt.length - 1);
        }
        return opt;
      });
      for (const param of params) {
        result.inputs.push({
          param,
          type: "options",
          options: cleanedOpts,
        });
      }
    } else {
      // Otherwise, attempt to parse as JSON (after replacing single quotes)
      try {
        const parsed = JSON.parse(optionsPart.replace(/'/g, '"'));
        if (Array.isArray(parsed)) {
          const cleanedOpts = parsed.map((o) => String(o));
          for (const param of params) {
            result.inputs.push({
              param,
              type: "options",
              options: cleanedOpts,
            });
          }
        } else {
          result.errors.push({
            line,
            directive,
            message: "Options provided in input directive are not an array.",
          });
        }
      } catch (e) {
        result.errors.push({
          line,
          directive,
          message: "Invalid options format in input directive.",
        });
      }
    }
  } else {
    // No options provided so assume a number input.
    for (const param of params) {
      result.inputs.push({
        param,
        type: "number",
      });
    }
  }
  return result;
}

/**
 * Parses a plot directive string.
 * Examples:
 *   "#| surface: some_func(x,..)" → a surface plot.
 *   "#| scatter: some_func(x,..)"  → a scatter plot.
 *   "#| curve: some_func(x,..)"    → a curve plot.
 *
 * @param directive The command portion of the plot directive.
 * @param plotType The plot type (e.g. "surface", "scatter", or "curve").
 * @param line The line number where this directive appears.
 * @returns A PlotParseResult with the parsed plot (if any) and errors.
 */
function parsePlotDirective(
  directive: string,
  plotType: string,
  line: number
): PlotParseResult {
  const result: PlotParseResult = { errors: [] };
  const validTypes = ["surface", "scatter", "curve"];
  const normalizedPlotType = plotType.replace(":", "").trim();
  if (!validTypes.includes(normalizedPlotType)) {
    result.errors.push({
      line,
      directive,
      message: `Invalid plot type "${normalizedPlotType}".`,
    });
    return result;
  }
  result.plot = {
    plot_type: normalizedPlotType as "surface" | "scatter" | "curve",
    command: directive,
  };
  return result;
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
} {
  const text = document.getText(range);
  const md = markdownit();
  const tokens = md.parse(text, {});
  const { language, title } = extractCodeBlocks(tokens)[0];

  return {
    code: text.replace(/^```[\w\-]*\s*|```$/gm, ""),
    language,
    title,
  };
}
