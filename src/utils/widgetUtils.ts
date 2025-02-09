import { Directives } from "../parser/directives";
/**
 * Converts a Map to a plain object so that it can be JSON‑stringified.
 */
function mapToObject(map: Map<string, string>): Record<string, string> {
  const obj: Record<string, string> = {};
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
  const execute = directives.execute.map((pe) => ({
    plot_type: pe.plot_type,
    commands: mapToObject(pe.commands),
  }));
  return { controls, execute };
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
 *   print(json.dumps({
 *     "type": "widget",
 *     "content": {
 *       "header": "INTERACTIVE_PLOT",
 *       "drafty_id": "my_drafty_id",
 *       "command": "init",
 *       "directives": { ... },
 *       "results": {"plot_type": "surface", "data": {"z": z}}
 *     }
 *   }))
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
  if (directives.execute.length > 0) {
    const plotExec = directives.execute[0];
    plotType = plotExec.plot_type;
    // For each command in the plot directive, assign a variable.
    plotExec.commands.forEach((value, key) => {
      // Generate a Python assignment for the command.
      // (Assumes the RHS is valid Python code.)
      lines.push(`${key} = ${value}`);
      // Also prepare the mapping for the JSON "data" field.
      plotDataAssignments.push(`"${key}": ${key}`);
    });
  }

  // === Build the widget output print statement ===
  // Clone directives while converting any Map objects to plain objects.
  const directivesClone = cloneDirectives(directives);
  // JSON-stringify the cloned directives.
  const directivesJson = JSON.stringify(directivesClone);

  // Build the results part.
  let resultsPart = "{}";
  if (plotDataAssignments.length > 0) {
    resultsPart = `{"plot_type": "${plotType}", "data": {${plotDataAssignments.join(
      ", "
    )}}}`;
  }

  // Construct the print statement per WidgetOutput
  lines.push("print(json.dumps({");
  lines.push('  "type": "widget",');
  lines.push('  "content": {');
  lines.push('    "header": "INTERACTIVE_PLOT",');
  lines.push(`    "drafty_id": "${drafty_id}",`);
  lines.push('    "command": "init",');
  lines.push(`    "directives": ${directivesJson},`);
  lines.push(`    "results": ${resultsPart}`);
  lines.push("  }");
  lines.push("}))");

  // Join all the lines with newline characters.
  return lines.join("\n");
}
