# Drafty: VSCode Markdown Code Runner with Jupyter-like Features

**Drafty** is a Visual Studio Code extension that lets you **run code blocks** embedded in Markdown files, track **session state** (variables, outputs) across multiple runs, and **save / load** execution results to/from JSON files.

## Quick Start

1. **Install the Extension**
   - Install from VS Code marketplace by searching for "Drafty Runner"
   - Or use the command: `code --install-extension fit-cnice.drafty`

2. **Create Fenced Python Code Block**

   ```python
   x = 42
   print(f"The answer is {x}")
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
