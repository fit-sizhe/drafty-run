# Drafty: VSCode Markdown Code Runner with Jupyter-like Features

**Drafty** lets you **run fenced python blocks** in Markdown files, track **session state** across multiple runs, and **save / load** execution results to/from JSON files.

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
   - Type "Drafty: Start Session"
   - Select your preferred Python environment in opened panel

4. **Run Your Code**
   - Now you can use a "Run Code Block" button above each code block
   - Click it to execute the code
   - Results will appear in the session panel

5. **Save Your Results**
   - Click the "Save"/"Save as" button in the results panel to store outputs
   - Use "Load Results" to restore previous session states

>**Remember: Always start a session before running code blocks. For more features, check out the detailed documentation below**.

