# Drafty: VSCode Markdown Code Runner with Jupyter-like Features

**Drafty** is a Visual Studio Code extension that lets you **run code blocks** embedded in Markdown files, track **session state** (variables, outputs) across multiple runs, and **save / load** execution results to JSON files.

## Key Features

1. **Run Code Blocks in Markdown**  
   - Adds CodeLens actions (“Run Code Block” / “Terminate Execution”) for code fences (```python ...```).
   - Each Markdown file has its own “session,” so variables defined in file1.md *don’t* interfere with file2.md.

2. **Result Panel**  
   - Displays text outputs, images (e.g. plots), and errors in a dedicated Webview Panel.  
   - Panels are **per-file**; each `.md` gets its own “Results” panel.

3. **Save / Load Results**  
   - **Load Results**: Picks a `.json` file and loads its previously-saved results.  
   - **Save As**: Lets you choose a folder/file name to save your session outputs as `.json`.  
   - **Save**: Automatically saves using a default path or last-used folder. 
   - Optional **saving rules** (e.g., “latest-only”) let you automatically remove old JSON files for that doc.

4. **Multienvironment Support**  
   - Choose which Python interpreter (Conda env, venv, etc.) to run with.  
   - Each environment is discovered at startup; you can switch quickly in the result panel.

5. **Per-Document Default Paths**  
   - Drafty remembers the folder used by each document’s last load / save.  
   - Pressing “Save” uses that same folder next time, making iterative saving more convenient.

## Result Display Logic

- **Streaming outputs**: As code runs, partial outputs (text, images) appear in real time in the panel.  
- **Block grouping**: Each code block’s output is grouped and collapsible.  
- **Images**: If your code (e.g. Python `matplotlib`) produces a figure, Drafty captures it as a base64 image and displays it inline.  
- **Errors**: Python exceptions (and optional tracebacks) appear in red text.

When you click **Run Code Block**, the extension will:
1. Create (or reveal) a Webview Panel for that `.md`.
2. Execute the code in a separate process (e.g., Python shell).
3. Capture partial outputs (stdout/stderr text, images, etc.) and stream them to the panel.
4. Update the session’s internal state (so variables persist across consecutive runs in the same file).

## Adding a New Code Runner

Drafty supports multiple languages by using the `ILanguageRunner` interface. To add a new language runner:

1. **Create a class** that implements `ILanguageRunner`. For example, a “NodeJSRunnerAdapter” might look like:

   ```ts
   // nodeRunner.ts
   import { ILanguageRunner } from './extension'; // or wherever ILanguageRunner is defined
   import { CellOutput } from './types';

   export class NodeRunnerAdapter implements ILanguageRunner {
       // docPath -> NodeJS processes or contexts
       private processes = new Map<string, any>();

       executeCode(
           docPath: string,
           code: string,
           envPath: string,
           blockId: string,
           onPartialOutput?: (output: CellOutput) => void
       ) {
           // 1) launch a NodeJS process with "code"
           // 2) capture stdout/stderr
           // 3) call onPartialOutput(...) with partial streams
           // 4) return { process, promise } for final outputs
       }

       clearState(docPath: string) {
           // if you keep any doc-based state in a map, reset it here
       }

       disposeRunner(docPath: string): void {
           // kill or clean up the process for docPath
           this.processes.delete(docPath);
       }
   }
   ```

2. **Register it** in your extension’s global map:

   ```ts
   // extension.ts
   import { NodeRunnerAdapter } from './nodeRunner';

   // languageRunners is a Map<string, ILanguageRunner>
   const nodeAdapter = new NodeRunnerAdapter();
   languageRunners.set('javascript', nodeAdapter);
   ```

3. **Fence Info**: If your Markdown code fence says \`\`\`javascript, Drafty will look up `languageRunners.get("javascript")`.  
4. **Implementation details**:  
   - `executeCode(docPath, code, envPath, blockId, onPartialOutput)` should launch and manage the language’s process or REPL.  
   - Return an object with `{ process, promise }`, where `process` is the underlying process handle for terminating, and `promise` resolves when execution finishes with final outputs.  
   - `clearState(docPath)` resets any in-memory or persistent state for that doc.  
   - `disposeRunner(docPath)` fully removes that doc’s runner instance if you’re storing it in a map.
