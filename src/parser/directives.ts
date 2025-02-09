// Updated types
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
  // LHS -> RHS of a plotting command, e.g. "y=some_func(a,b)" becomes y -> some_func(a,b)
  commands: Map<string, string>;
};

export interface Directives {
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

// ----------------------------------------------------------------------
// Helper function to split a string by top-level delimiters (',' or ';')
// It splits only on delimiters that are not enclosed in (), [], or {}.
function splitByTopLevelDelimiters(input: string): string[] {
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
    // Split if we hit a delimiter at top level.
    if ((char === "," || char === ";") && depth === 0) {
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

// ----------------------------------------------------------------------
// Main parser function
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
          directives.execute.push(plotResult.plot);
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
 *   "#| slider: a, 1, 5"  → creates a slider for "a" with current set to 3.
 *   "#| slider: b, 1, 6, 3" → allowed values: [1,4] → current set to 1.
 *   "#| slider: c, 1, 7, 3" → allowed values: [1,4,7] → current set to 4.
 *
 * @param directive The directive string (without "slider:").
 * @param line The 1-indexed line number.
 * @returns A SliderParseResult with parsed sliders and errors.
 */
function parseSliderDirective(
  directive: string,
  line: number
): SliderParseResult {
  const result: SliderParseResult = { errors: [] };
  const tokens = splitByTopLevelDelimiters(directive);

  if (tokens.length < 3) {
    result.errors.push({
      line,
      directive,
      message: "Slider directive must have at least 3 parts (param, min, max).",
    });
    return result;
  }
  if (tokens.length > 4) {
    result.errors.push({
      line,
      directive,
      message: "Slider directive has too many parts.",
    });
    return result;
  }

  const paramPart = tokens[0];
  const minStr = tokens[1];
  const maxStr = tokens[2];
  const stepStr = tokens[3];

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

  // Compute the "current" value.
  let current: number;
  if (step === undefined) {
    // Continuous slider: use the arithmetic median.
    current = (min + max) / 2;
  } else {
    // Discrete slider: compute allowed values.
    const allowed: number[] = [];
    for (let val = min; val <= max + 1e-9; val += step) {
      allowed.push(val);
    }
    if (allowed.length === 0) {
      result.errors.push({
        line,
        directive,
        message: "No allowed values computed for slider directive.",
      });
      return result;
    }
    // Choose the median: if even, choose the first element.
    if (allowed.length % 2 === 1) {
      current = allowed[Math.floor(allowed.length / 2)];
    } else {
      current = allowed[0];
    }
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
      directive,
      message: "No parameter specified in slider directive.",
    });
    return result;
  }

  result.sliders = params.map((param) => ({
    param,
    type: "slider",
    min,
    max,
    step,
    current,
  }));

  return result;
}

/**
 * Parses an input directive string.
 * Examples:
 *   "#| input: a, 3" → a number input for "a" with default (current) value 3.
 *   "#| input: [a,b], 0" → number inputs for "a" and "b" with default 0.
 *   "#| input: b, ['opt1','opt2']" → an options input for "b" (current set to "opt1").
 *
 * For a number input, the syntax is now: param, default_value.
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
  const result: InputParseResult = { errors: [] };
  const tokens = splitByTopLevelDelimiters(directive);

  if (tokens.length < 2) {
    result.errors.push({
      line,
      directive,
      message:
        "Input directive must have two parts: parameter(s) and default value/options.",
    });
    return result;
  }
  if (tokens.length > 2) {
    result.errors.push({
      line,
      directive,
      message: "Input directive has too many parts.",
    });
    return result;
  }

  const paramPart = tokens[0];
  const secondPart = tokens[1];

  // Allow multiple parameters if enclosed in square brackets.
  const params = paramPart
    .replace(/^\[|\]$/g, "")
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
  // Determine whether this is an options input or a number input.
  if (secondPart.startsWith("[") && secondPart.endsWith("]")) {
    // Options input: parse the options list.
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
        directive,
        message: "Empty options list in input directive.",
      });
      return result;
    }
    // For options input, current is set to the first option.
    for (const param of params) {
      result.inputs.push({
        param,
        type: "options",
        options,
        current: options[0],
      });
    }
  } else {
    // Number input: secondPart should be the default value.
    const defaultVal = parseFloat(secondPart);
    if (isNaN(defaultVal)) {
      result.errors.push({
        line,
        directive,
        message: "Invalid default value for number input directive.",
      });
      return result;
    }
    for (const param of params) {
      result.inputs.push({
        param,
        type: "number",
        current: defaultVal,
      });
    }
  }

  return result;
}

/**
 * Parses a plot directive string.
 * Examples:
 *   "#| surface: y = some_func(x,..)" → a surface plot.
 *   "#| surface: y1=some_func(x,..); y2" → multiple surfaces in one plot (no recalc on y2).
 *   "#| scatter: y = some_func(x,..)"  → a scatter plot.
 *   "#| scatter: y1=some_func(x,..); y2 = some_func();"  → a scatter plot of multiple dot styles.
 *   "#| curve: y = some_func(x,..)"    → a curve plot.
 *   "#| curve: y1=some_func(x,..); y2 = some_func(x,..);"  → multiple curves in one plot.
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

  const tokens = splitByTopLevelDelimiters(directive);
  if (tokens.length === 0) {
    result.errors.push({
      line,
      directive,
      message: "No commands found in plot directive.",
    });
    return result;
  }

  const commandsMap = new Map<string,string>();
  for (const cmd of tokens) {
    const equalIndex = cmd.indexOf("=");
    if (equalIndex >= 0) {
      const lhs = cmd.substring(0, equalIndex).trim();
      const rhs = cmd.substring(equalIndex + 1).trim();
      if (!lhs) {
        result.errors.push({
          line,
          directive: cmd,
          message: "Missing left-hand side in plot command.",
        });
        continue;
      }
      if (!rhs) {
        result.errors.push({
          line,
          directive: cmd,
          message: `Missing right-hand side in plot command for "${lhs}".`,
        });
        continue;
      }
      commandsMap.set(lhs,rhs);
    } else {
      const lhs = cmd.trim();
      if (!lhs) {
        result.errors.push({
          line,
          directive: cmd,
          message: "Empty plot command found.",
        });
        continue;
      }
      commandsMap.set(lhs,"");
    }
  }

  if (!commandsMap) {
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
