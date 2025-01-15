# Drafty: VSCode Markdown Code Runner with Jupyter-like Features

**Drafty** is a Visual Studio Code extension that lets you **run code blocks** embedded in Markdown files, track **session state** (variables, outputs) across multiple runs, and **save / load** execution results to JSON files.

## Quick Start

1. **Install the Extension**
   - Install from VS Code marketplace by searching for "Drafty Runner"
   - Or use the command: `code --install-extension fit-cnice.drafty`

2. **Create a New Markdown File**
   ```markdown
   # My First Drafty Document
   
   ```python
   x = 42
   print(f"The answer is {x}")
   ```
   ```

3. **Start a Session**
   - Open the Command Palette (Ctrl+Shift+P / Cmd+Shift+P)
   - Type "drafty: Start Markdown Code Session"
   - Select your preferred Python environment in opened panel

4. **Run Your Code**
   - Now you can use a "Run Code Block" button above each code block
   - Click it to execute the code
   - Results will appear in the session panel

5. **Save Your Results**
   - Click the "Save"/"Save as" button in the results panel to store outputs
   - Use "Load Results" to restore previous session states

>**Remember: Always start a session before running code blocks. For more features, check out the detailed documentation below**.

## Key Features

1. **Jupyter-like Code Execution**
   - Full Jupyter kernel integration for Python code execution
   - Real-time output streaming for text, images, and rich HTML content
   - Support for matplotlib plots with automatic display
   - Interrupt long-running code execution with terminate button
   - Maintains session state between code block runs

2. **Rich Output Display**
   - Real-time streaming of stdout/stderr text output
   - Automatic display of matplotlib plots and figures
   - Support for rich HTML output
   - Error display with traceback information
   - Collapsible output blocks with execution timing

3. **Multiple Environment Support**
   - Automatic detection of Python environments (conda, venv, system)
   - Easy switching between environments in the results panel
   - Support for both global and per-document environment selection
   - Remembers environment choice per document

4. **Session Management**
   - Each Markdown file has its own isolated execution session
   - Variables and state persist between code block runs
   - Clear session state with one click
   - Session state is preserved when saving/loading results

5. **Save/Load Functionality**
   - Save execution results as JSON files
   - Load previous results to restore session state
   - Automatic naming with timestamps
   - Optional "latest-only" mode to manage storage
   - Remember last used save location per document

6. **User Interface**
   - CodeLens actions for running/terminating code blocks
   - Dedicated results panel with environment selector
   - Adjustable output height
   - Real-time execution status indicators
   - Clean, VS Code-native styling

## Result Display Logic

- **Streaming outputs**: As code runs, partial outputs (text, images) appear in real time in the panel.  
- **Block grouping**: Each code block's output is grouped and collapsible.  
- **Images**: If your code (e.g. Python `matplotlib`) produces a figure, Drafty captures it as a base64 image and displays it inline.  
- **Errors**: Python exceptions (and optional tracebacks) appear in red text.

When you click **Run Code Block**, the extension will:
1. Create (or reveal) a Webview Panel for that `.md`.
2. Execute the code in a separate process (e.g., Python shell).
3. Capture partial outputs (stdout/stderr text, images, etc.) and stream them to the panel.
4. Update the session's internal state (so variables persist across consecutive runs in the same file).

## Adding a New Code Runner

Drafty supports multiple languages by using the `ILanguageRunner` interface. To add a new language runner:

1. **Create a class** that implements `ILanguageRunner`. For example, a "NodeJSRunnerAdapter" might look like:

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

2. **Register it** in your extension's global map:

   ```ts
   // extension.ts
   import { NodeRunnerAdapter } from './nodeRunner';

   // languageRunners is a Map<string, ILanguageRunner>
   const nodeAdapter = new NodeRunnerAdapter();
   languageRunners.set('javascript', nodeAdapter);
   ```

3. **Fence Info**: If your Markdown code fence says \`\`\`javascript, Drafty will look up `languageRunners.get("javascript")`.  
4. **Implementation details**:  
   - `executeCode(docPath, code, envPath, blockId, onPartialOutput)` should launch and manage the language's process or REPL.  
   - Return an object with `{ process, promise }`, where `process` is the underlying process handle for terminating, and `promise` resolves when execution finishes with final outputs.  
   - `clearState(docPath)` resets any in-memory or persistent state for that doc.  
   - `disposeRunner(docPath)` fully removes that doc's runner instance if you're storing it in a map.
