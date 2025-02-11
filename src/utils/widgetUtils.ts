import { Directives } from "../parser/directives";
import { ParseError } from "../parser/directives";
import { ErrorOutput } from "../types";
/**
 * Converts a Map to a plain object so that it can be JSON‑stringified.
 */
function mapToObject(
  map: Map<string, { args: string[]; exec: string }>
): Record<string, { args: string[]; exec: string }> {
  const obj: Record<string, { args: string[]; exec: string }> = {};
  map.forEach((v, k) => {
    obj[k] = v;
  });
  return obj;
}

/**
 * Deep-clones a Directives object, converting any Map properties
 * (such as PlotExec.commands) into plain objects.
 */
function cloneDirectives(directives: Directives) {
  // Clone controls array (they are plain objects already)
  const controls = directives.controls.slice();

  // Clone execute array, converting each Map to an object.
  const plot_executes = directives.plot_executes.map((pe) => ({
    plot_type: pe.plot_type,
    commands: mapToObject(pe.commands),
  }));
  return { controls, plot_executes };
}

/**
 * Given parsed directives and a drafty_id, returns a string containing Python code.
 *
 * The generated Python code will:
 *  - Import json.
 *  - Assign control values to Python variables.
 *  - Execute plot command(s) (by assigning the result of the function call).
 *  - Finally, print a JSON object conforming to your WidgetOutput type.
 *
 * Example input directives:
 *   #| slider: a, 1,5
 *   #| input: b, 10
 *   #| surface: z=some_func(x,y)
 *
 * Example generated Python snippet:
 *
 *   import json
 *   a = 3
 *   b = 10
 *   z = some_func(x,y)
 *   json.dumps({
 *     "type": "widget",
 *     "content": {
 *       "header": "INTERACTIVE_PLOT",
 *       "drafty_id": "my_drafty_id",
 *       "command": "init",
 *       "directives": { ... },
 *       "results": {"plot_type": "surface", "args": {"x":x, "y":y}, "data": {"z": z}}
 *     }
 *   })
 *
 * @param directives The parsed directives.
 * @param drafty_id The drafty_id string.
 * @returns A string containing the Python code.
 */
export function generatePythonSnippet(
  directives: Directives,
  drafty_id: string
): string {
  const lines: string[] = [];
  // Begin with the json import.
  lines.push("import json");

  // === Process controls ===
  // For each control (either slider or input), create a Python assignment.
  directives.controls.forEach((control) => {
    // For a slider or a number input, the current value is numeric.
    if (control.type === "slider" || control.type === "number") {
      lines.push(`${control.param} = ${control.current}`);
    } else if (control.type === "options") {
      // For an options input, wrap the current value in quotes.
      lines.push(`${control.param} = '${control.current}'`);
    }
  });

  // === Process plot directives ===
  // For simplicity, use only the first plot directive (if any).
  let plotType = "";
  const plotDataAssignments: string[] = [];
  for (const plotExec of directives.plot_executes) {
    if(!plotType) {
      plotType = plotExec.plot_type;
    // ignore plot type other than the first found type
    } else if (plotType != plotExec.plot_type) {
      continue;
    }
    // For each command in the plot directive, assign a variable.
    plotExec.commands.forEach((value, key) => {
      // Generate a Python assignment for the command
      if (value.exec != "") lines.push(`${key} = ${value.exec}`);
      // Also prepare the mapping
      plotDataAssignments.push(`"data": {"${key}": ${key}}`);
      let args: string[] = [];
      for (const arg of value.args) args.push(`"${arg}": ${arg}`);
      plotDataAssignments.push(`"args": {${args.join(", ")}}`);
    });
  }

  // === Build the widget output print statement ===
  // Clone directives while converting any Map objects to plain objects.
  const directivesClone = cloneDirectives(directives);
  const directivesJson = JSON.stringify(directivesClone);

  // Build the results part.
  let resultsPart = "{}";
  if (plotDataAssignments.length > 0) {
    resultsPart = `{"plot_type": "${plotType}", ${plotDataAssignments.join(
      ", "
    )}}`;
  }

  // Construct the print statement per WidgetOutput
  lines.push("json.dumps({");
  lines.push('  "type": "widget",');
  lines.push('  "content": {');
  lines.push('    "header": "INTERACTIVE_PLOT",');
  lines.push(`    "drafty_id": "${drafty_id}",`);
  lines.push('    "command": "init",');
  lines.push(`    "directives": ${directivesJson},`);
  lines.push(`    "results": ${resultsPart}`);
  lines.push("  }");
  lines.push("})");

  // Join all the lines with newline characters.
  return lines.join("\n");
}

export function convertParseError(parseError: ParseError): ErrorOutput {
  return {
    type: "error",
    timestamp: Date.now(),
    error: `Error on line ${parseError.line}: ${parseError.message}`,
    traceback: [
      `Directive: ${parseError.directive}`
    ]
  };
}
