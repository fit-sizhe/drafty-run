// Updated types for directive parsing
export type Input = {
  param: string;
  type: "number" | "options";
  options?: string[];
  current: string | number;
};

export type Slider = {
  param: string;
  type: "slider";
  min: number;
  max: number;
  step?: number;
  current: number;
};

export type PlotExec = {
  plot_type: "surface" | "scatter" | "curve";
  // LHS -> RHS of a plotting command,
  // type‑1 surface: parse x/y/z from simple command,
  // e.g. "#| surface: z=some_func(x,y,a,b,c)" becomes "z" -> {args:["x","y"], exec:"some_func(x,y,a,b,c)"}
  // where "a"/"b"/"c" are none-axis arguments
  // type‑2 surface: parse x/y/z from 3-tuple (this is allowed)
  // "#| surface: [x1, x2, y]" becomes "y" -> {args:["x1","x2"], exec:""}
  // type‑1 curve and type‑1 scatter: parse x/y from simple command,
  // e.g. "#| curve: y=some_func(x,a,b)" becomes "y" -> {args:["x"], exec:"some_func(x,a,b)"}
  // type‑2 curve and type‑2 scatter: parse x/y from 2-tuple
  // e.g. "#| scatter: [x1,x2]" becomes "x2" -> {args:["x1"], exec:""}
  commands: Map<string, { args: string[]; exec: string }>;
};

export interface Directives {
  plot_executes: PlotExec[]; // one plot -> multiple plot exec
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

// ----------------------------------------------------------------------
// Helper function to split a string by top-level delimiters (',' or ';')
// Checks if the given delimiter appears at top level in the input.
function hasTopLevelDelimiter(input: string, delim: string): boolean {
  let depth = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (char === "(" || char === "[" || char === "{") {
      depth++;
    } else if (char === ")" || char === "]" || char === "}") {
      if (depth > 0) depth--;
    } else if (char === delim && depth === 0) {
      return true;
    }
  }
  return false;
}

// Splits the input string on the given delimiter—but only when that delimiter is at top level.
function splitByDelimiterAtTopLevel(input: string, delim: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let depth = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (char === "(" || char === "[" || char === "{") {
      depth++;
    } else if (char === ")" || char === "]" || char === "}") {
      if (depth > 0) depth--;
    }
    if (char === delim && depth === 0) {
      if (current.trim() !== "") {
        tokens.push(current.trim());
      }
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim() !== "") {
    tokens.push(current.trim());
  }
  return tokens;
}

// count top-level occurrences of a delimiter,
// used to check if ; and , are mixed used at top level
function countTopLevelDelimiterAt(input: string, delim: string): number {
  let count = 0;
  let depth = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (char === "(" || char === "[" || char === "{") {
      depth++;
    } else if (char === ")" || char === "]" || char === "}") {
      if (depth > 0) depth--;
    } else if (char === delim && depth === 0) {
      count++;
    }
  }
  return count;
}

// For controls (slider/input), if both top-level ";" and "," are present,
// use ";" as the primary separator and then split each part by ",".
function splitDirectiveForControls(input: string): string[][] {
  if (hasTopLevelDelimiter(input, ";")) {
    const primaryParts = splitByDelimiterAtTopLevel(input, ";");
    return primaryParts.map((part) => {
      return splitByDelimiterAtTopLevel(part, ",")
        .map((token) => token.trim())
        .filter((token) => token.length > 0);
    });
  } else {
    return [
      splitByDelimiterAtTopLevel(input, ",")
        .map((token) => token.trim())
        .filter((token) => token.length > 0),
    ];
  }
}

// For plot directives, if any top-level ";" exists, split only on ";";
// otherwise, split on ",".
function splitDirectiveForPlot(input: string): string[] {
  if (hasTopLevelDelimiter(input, ";")) {
    return splitByDelimiterAtTopLevel(input, ";")
      .map((token) => token.trim())
      .filter((token) => token.length > 0);
  } else {
    return splitByDelimiterAtTopLevel(input, ",")
      .map((token) => token.trim())
      .filter((token) => token.length > 0);
  }
}

// ----------------------------------------------------------------------
// Main parser function
export function parseDirectivesFromStr(code: string): ParseResult {
  const lines = code.split("\n");
  const directives: Directives = { plot_executes: [], controls: [] };
  const errors: ParseError[] = [];
  let hasDirectives = false;
  let onlyPlotType = ""; // there should be only one and only one type

  for (let i = 0; i < lines.length; i++) {
    const trimmedLine = lines[i].trim();
    if (trimmedLine.startsWith("#|")) {
      hasDirectives = true;
      const directiveText = trimmedLine.substring(2).trim();

      if (directiveText.startsWith("slider:")) {
        const sliderResult = parseSliderDirective(
          directiveText.substring(7).trim(),
          i + 1
        );
        if (sliderResult.sliders) {
          directives.controls.push(...sliderResult.sliders);
        }
        errors.push(...sliderResult.errors);
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
          if (onlyPlotType && onlyPlotType != plotResult.plot.plot_type) {
            errors.push({
              line: i + 1,
              directive: directiveText.substring(colonIdx + 1).trim(),
              message: "Each Canvas Can Draw Only ONE Plot Type.",
            });
          } else if (!onlyPlotType) onlyPlotType = plotResult.plot.plot_type;

          directives.plot_executes.push(plotResult.plot);
        }
        errors.push(...plotResult.errors);
      } else {
        // other metadata
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
 *   "#| slider: a, 1, 5" → creates a slider for "a" with current = 3.
 *   "#| slider: [a,b], 1,5" → creates sliders for "a" and "b" with current = 3.
 *   "#| slider: [a,b], 1,5; c,2,8" → creates two directives:
 *         one for [a,b] (min=1,max=5,current=3) and one for c (min=2,max=8,current=5).
 *
 * @param directive The directive string (without "slider:").
 * @param line The 1-indexed line number.
 * @returns A SliderParseResult with parsed sliders and errors.
 */
function parseSliderDirective(
  directive: string,
  line: number
): SliderParseResult {
  // If there is no top-level comma but there is a semicolon,
  // then treat semicolon as a comma.
  if (
    countTopLevelDelimiterAt(directive, ",") === 0 &&
    countTopLevelDelimiterAt(directive, ";") > 0
  ) {
    directive = directive.replace(/;/g, ",");
  }
  const result: SliderParseResult = { sliders: [], errors: [] };
  const directivesArray = splitDirectiveForControls(directive);

  // Process each control directive separately.
  directivesArray.forEach((parts) => {
    if (parts.length < 3) {
      result.errors.push({
        line,
        directive: parts.join(", "),
        message:
          "Slider directive must have at least 3 parts (param, min, max).",
      });
      return result;
    }
    if (parts.length > 4) {
      result.errors.push({
        line,
        directive: parts.join(", "),
        message: "Slider directive has too many parts.",
      });
      return result;
    }
    const paramPart = parts[0];
    const minStr = parts[1];
    const maxStr = parts[2];
    const stepStr = parts[3]; // Optional
    const min = parseFloat(minStr);
    const max = parseFloat(maxStr);
    if (isNaN(min) || isNaN(max)) {
      result.errors.push({
        line,
        directive: parts.join(", "),
        message: "Invalid min or max value in slider directive.",
      });
      return;
    }
    let step: number | undefined = undefined;
    if (stepStr !== undefined) {
      const s = parseFloat(stepStr);
      if (!isNaN(s)) {
        step = s;
      } else {
        result.errors.push({
          line,
          directive: parts.join(", "),
          message: "Invalid step value in slider directive.",
        });
      }
    }
    // Compute the "current" value.
    let current: number;
    if (step === undefined) {
      current = (min + max) / 2;
    } else {
      const allowed: number[] = [];
      for (let val = min; val <= max + 1e-9; val += step) {
        allowed.push(val);
      }
      if (allowed.length === 0) {
        result.errors.push({
          line,
          directive: parts.join(", "),
          message: "No allowed values computed for slider directive.",
        });
        return;
      }
      current =
        allowed.length % 2 === 1
          ? allowed[Math.floor(allowed.length / 2)]
          : allowed[0];
    }
    // Allow multiple parameters if enclosed in square brackets.
    const params = paramPart
      .replace(/^\[|\]$/g, "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s);
    if (params.length === 0) {
      result.errors.push({
        line,
        directive: parts.join(", "),
        message: "No parameter specified in slider directive.",
      });
      return;
    }
    params.forEach((param) => {
      result.sliders!.push({
        param,
        type: "slider",
        min,
        max,
        step,
        current,
      });
    });
  });
  return result;
}

/**
 * Parses an input directive string.
 * Examples:
 *   "#| input: a, 10" → a numeric input for "a" with default = 10.
 *   "#| input: [a,b], 10" → numeric inputs for "a" and "b" with default = 10.
 *   "#| input: a, 10; [b,c], ['opt1','opt2']" → two separate input directives.
 *
 * For a number input, the syntax is: param, default_value.
 * For an options input, the syntax remains with an options array.
 *
 * @param directive The directive string (without "input:" or "input;").
 * @param line The 1-indexed line number.
 * @returns An InputParseResult with parsed inputs and errors.
 */
function parseInputDirective(
  directive: string,
  line: number
): InputParseResult {
  if (
    countTopLevelDelimiterAt(directive, ",") === 0 &&
    countTopLevelDelimiterAt(directive, ";") > 0
  ) {
    directive = directive.replace(/;/g, ",");
  }
  const result: InputParseResult = { inputs: [], errors: [] };
  const directivesArray = splitDirectiveForControls(directive);

  directivesArray.forEach((parts) => {
    if (parts.length < 2) {
      result.errors.push({
        line,
        directive: parts.join(", "),
        message:
          "Input directive must have two parts: parameter(s) and default value/options.",
      });
      return;
    }
    if (parts.length > 2) {
      result.errors.push({
        line,
        directive: parts.join(", "),
        message: "Input directive has too many parts.",
      });
    }
    const paramPart = parts[0];
    const secondPart = parts[1];
    const params = paramPart
      .replace(/^\[|\]$/g, "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s);
    if (params.length === 0) {
      result.errors.push({
        line,
        directive: parts.join(", "),
        message: "No parameter specified in input directive.",
      });
      return;
    }
    if (secondPart.startsWith("[") && secondPart.endsWith("]")) {
      // Options input.
      const inner = secondPart.substring(1, secondPart.length - 1);
      let options = inner
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s);
      options = options.map((opt) => {
        if (
          (opt.startsWith("'") && opt.endsWith("'")) ||
          (opt.startsWith('"') && opt.endsWith('"'))
        ) {
          return opt.substring(1, opt.length - 1);
        }
        return opt;
      });
      if (options.length === 0) {
        result.errors.push({
          line,
          directive: parts.join(", "),
          message: "Empty options list in input directive.",
        });
        return;
      }
      params.forEach((param) => {
        result.inputs!.push({
          param,
          type: "options",
          options,
          current: options[0],
        });
      });
    } else {
      // Number input.
      const defaultVal = parseFloat(secondPart);
      if (isNaN(defaultVal)) {
        result.errors.push({
          line,
          directive: parts.join(", "),
          message: "Invalid default value for number input directive.",
        });
        return;
      }
      params.forEach((param) => {
        result.inputs!.push({
          param,
          type: "number",
          current: defaultVal,
        });
      });
    }
  });
  return result;
}

/**
 * Parses a plot directive string.
 * Examples:
 *   "#| surface: z=some_func(x,y,a,b,c)" → type‑1 surface:
 *         key "z" -> { args: ["x", "y"], exec: "some_func(x,y,a,b,c)" }
 *   "#| surface: [x1, x2, z]" → type‑2 surface:
 *         key "z" -> { args: ["x1", "x2"], exec: "" }
 *   "#| curve: y=some_func(x,a,b)" → type‑1 curve:
 *         key "y" -> { args: ["x"], exec: "some_func(x,a,b)" }
 *   "#| scatter: [x1,y]" → type‑2 scatter:
 *         key "y" -> { args: ["x1"], exec: "" }
 *
 * If both top-level ";" and "," are present in the directive, then ";" is used as the primary separator.
 *
 * @param directive The command portion of the plot directive.
 * @param plotType The plot type (e.g. "surface", "scatter", or "curve").
 * @param line The 1-indexed line number.
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
  // For plot directives, if any top-level ";" exists, split only on ";".
  const tokens = splitDirectiveForPlot(directive);
  if (tokens.length === 0) {
    result.errors.push({
      line,
      directive,
      message: "No commands found in plot directive.",
    });
    return result;
  }
  const commandsMap = new Map<string, { args: string[]; exec: string }>();
  tokens.forEach((token) => {
    // Type-1: token contains "=".
    if (token.indexOf("=") >= 0) {
      const equalIndex = token.indexOf("=");
      const lhs = token.substring(0, equalIndex).trim();
      const rhs = token.substring(equalIndex + 1).trim();
      if (!lhs) {
        result.errors.push({
          line,
          directive: token,
          message: "Missing left-hand side in plot command.",
        });
        return;
      }
      if (!rhs) {
        result.errors.push({
          line,
          directive: token,
          message: `Missing right-hand side in plot command for "${lhs}".`,
        });
        return;
      }
      const openParen = rhs.indexOf("(");
      const closeParen = rhs.lastIndexOf(")");
      if (openParen < 0 || closeParen < 0 || closeParen <= openParen) {
        result.errors.push({
          line,
          directive: token,
          message: "Expected a function call with parentheses in plot command.",
        });
        return;
      }
      const innerArgsStr = rhs.substring(openParen + 1, closeParen);
      const argTokens = splitByDelimiterAtTopLevel(innerArgsStr, ",")
        .map((s) => s.trim())
        .filter((s) => s);
      const expectedAxis = normalizedPlotType === "surface" ? 2 : 1;
      const axisArgs = argTokens.slice(0, expectedAxis);
      commandsMap.set(lhs, { args: axisArgs, exec: rhs });
    } else {
      // Type-2: no "=".
      if (token.startsWith("[") && token.endsWith("]")) {
        const inner = token.substring(1, token.length - 1);
        const parts = splitByDelimiterAtTopLevel(inner, ",")
          .map((s) => s.trim())
          .filter((s) => s);
        if (normalizedPlotType === "surface") {
          if (parts.length < 3) {
            result.errors.push({
              line,
              directive: token,
              message:
                "Type-2 surface command requires a 3-tuple: two axis arguments and a key.",
            });
            return;
          }
        } else {
          if (parts.length < 2) {
            result.errors.push({
              line,
              directive: token,
              message:
                "Type-2 curve/scatter command requires a 2-tuple: one axis argument and a key.",
            });
            return;
          }
        }
        const key = parts[parts.length - 1];
        const axisArgs = parts.slice(0, parts.length - 1);
        commandsMap.set(key, { args: axisArgs, exec: "" });
      } else {
        const key = token.trim();
        if (!key) {
          result.errors.push({
            line,
            directive: token,
            message: "Empty plot command found.",
          });
          return;
        }
        commandsMap.set(key, { args: [], exec: "" });
      }
    }
  });
  if (commandsMap.size === 0) {
    result.errors.push({
      line,
      directive,
      message: "No valid plot commands found in directive.",
    });
    return result;
  }

  result.plot = {
    plot_type: normalizedPlotType as "surface" | "scatter" | "curve",
    commands: commandsMap,
  };

  return result;
}
