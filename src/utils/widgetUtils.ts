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
 *       "results": [{"plot_type": "surface", "args": {"x":x, "y":y}, "data": {"z": z}}]
 *     }
 *   })
 *
 * @param directives The parsed directives.
 * @param drafty_id The drafty_id string.
 * @returns A string containing the Python code.
 */
export function generatePythonSnippet(
  directives: Directives,
  drafty_id: string,
  command?: "init" | "update"
): string {
  const lines: string[] = [];
  // Begin with the json import.
  if (command != "update"){
    lines.push("import json");
    lines.push(getSerializeFunction());
  }
  

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
    if (!plotType) {
      plotType = plotExec.plot_type;
      // ignore plot type other than the first found type
    } else if (plotType != plotExec.plot_type) {
      continue;
    }
    // For each command in the plot directive, assign a variable.
    plotExec.commands.forEach((value, key) => {
      let resEntry = `{"plot_type": "${plotType}", `;
      // Generate a Python assignment for the command
      if (value.exec != "") lines.push(`${key} = ${value.exec}`);
      resEntry += `"data": {"${key}": _x2list(${key})}`;
      let args: string[] = [];
      for (const arg of value.args) args.push(`"${arg}": _x2list(${arg})`);
      resEntry += `, "args": {${args.join(", ")}}}`;
      plotDataAssignments.push(resEntry);
    });
  }

  // === Build the widget output print statement ===
  // Clone directives while converting any Map objects to plain objects.
  const directivesClone = cloneDirectives(directives);
  const directivesJson = JSON.stringify(directivesClone);

  // Build the results part.
  let resultsPart = [];
  if (plotDataAssignments.length > 0) {
    resultsPart.push(`${plotDataAssignments}`);
  }

  // Construct the print statement per WidgetOutput
  lines.push("json.dumps({");
  lines.push('  "type": "widget",');
  lines.push('  "content": {');
  lines.push('    "header": "INTERACTIVE_PLOT",');
  lines.push(`    "drafty_id": "${drafty_id}",`);
  lines.push(`    "command": "${command ?? "init"}",`);
  lines.push(`    "directives": ${directivesJson},`);
  lines.push(`    "results": [${resultsPart.join(", ")}]`);
  lines.push("  }");
  lines.push("})");

  // console.log(lines.join("\n"));
  // Join all the lines with newline characters.
  return lines.join("\n");
}

export function convertParseError(parseError: ParseError): ErrorOutput {
  return {
    type: "error",
    timestamp: Date.now(),
    error: `Error on line ${parseError.line}: \n${parseError.message}`,
    traceback: [`Directive: ${parseError.directive}`],
  };
}

function getSerializeFunction(): string {
  return `
_IMPORT_CACHE = {}
def _try_import(module_name):
    if module_name in _IMPORT_CACHE:
        return _IMPORT_CACHE[module_name]
    try:
        mod = __import__(module_name, fromlist=["dummy"])
        _IMPORT_CACHE[module_name] = mod
        return mod
    except ImportError:
        _IMPORT_CACHE[module_name] = None
        return None

def _recursive_convert(obj):
    if isinstance(obj, (str, bytes)):
        return obj
    try:
        iter(obj)
    except TypeError:
        return obj
    return [recursive_convert(x) for x in obj]

def _x2list(arr):
    if isinstance(arr, list):
        return arr

    tf = _try_import("tensorflow")
    torch = _try_import("torch")
    pd = _try_import("pandas")
    sp = _try_import("scipy.sparse")
    np = _try_import("numpy")

    if hasattr(arr, "__array_interface__"):
        if np is not None:
            return np.asarray(arr).tolist()
        else:
            return recursive_convert(arr)

    if tf is not None and isinstance(arr, (tf.Tensor, getattr(tf, "Variable", type(None)))):
        return arr.tolist() if hasattr(arr, "tolist") else recursive_convert(arr)

    if torch is not None and isinstance(arr, torch.Tensor):
        return arr.detach().cpu().tolist()

    if pd is not None and isinstance(arr, (pd.DataFrame, pd.Series)):
        return arr.values.tolist()

    if sp is not None and hasattr(sp, "isspmatrix") and sp.isspmatrix(arr):
        return arr.toarray().tolist()

    if hasattr(arr, "tolist"):
        return arr.tolist()

    return _recursive_convert(arr)`;
}
