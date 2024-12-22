// pythonRunner.ts

import { PythonShell } from 'python-shell';
import * as path from 'path';
import * as fs from 'fs';
import { CellOutput } from './types';

const PYTHON_SETUP_CODE = `
import sys
import io
import json
import traceback
import base64
import types
import copy
from contextlib import redirect_stdout, redirect_stderr

# Configure matplotlib for non-interactive backend
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

class OutputCollector:
    def __init__(self):
        self._outputs = []
        self._current_timestamp = None
    
    def _add_output(self, output_type: str, **kwargs):
        if self._current_timestamp is None:
            from datetime import datetime
            self._current_timestamp = datetime.now().timestamp() * 1000
        
        output = {
            'type': output_type,
            'timestamp': self._current_timestamp,
            **kwargs
        }
        self._outputs.append(output)
    
    def add_text(self, text: str, stream: str = 'stdout'):
        if text.strip():
            self._add_output('text', content=text.strip(), stream=stream)
    
    def add_image(self, format: str = 'png', **kwargs):
        buf = io.BytesIO()
        
        if format == 'png':
            plt.savefig(buf, format='png', bbox_inches='tight', dpi=100)
        elif format == 'svg':
            plt.savefig(buf, format='svg', bbox_inches='tight')
        
        buf.seek(0)
        image_data = base64.b64encode(buf.getvalue()).decode('utf-8')
        
        self._add_output('image',
                         format=format,
                         data=image_data,
                         metadata=kwargs)
        plt.close('all')
    
    def add_error(self, error: Exception):
        tb = traceback.extract_tb(error.__traceback__)
        self._add_output('error',
                         error=str(error),
                         traceback=[str(frame) for frame in tb])
    
    def add_rich(self, content: str, format: str = 'html'):
        self._add_output('rich', content=content, format=format)
    
    def get_outputs(self):
        return json.dumps(self._outputs)

# Create an output collector for this execution
output_collector = OutputCollector()

def custom_display_hook(obj):
    if obj is not None:
        # Show the object's repr as text
        output_collector.add_text(repr(obj))

sys.__displayhook__ = custom_display_hook

def cleanup_plots():
    if plt.get_fignums():
        output_collector.add_image()
        plt.close('all')
`;

export class PythonRunner {
    private static instance: PythonRunner;
    
    // We'll store a "globalState" to allow basic retention of variables across runs.
    private globalState: { [key: string]: any } = {};

    private constructor() {}

    public static getInstance(): PythonRunner {
        if (!PythonRunner.instance) {
            PythonRunner.instance = new PythonRunner();
        }
        return PythonRunner.instance;
    }

    /**
     * Executes `code` in a temporary Python script using the specified `pythonPath`.
     * 
     * @param code        The Python code to execute.
     * @param pythonPath  The interpreter path (e.g., "python3", "/path/to/venv/bin/python").
     */
    public async executeCode(code: string, pythonPath: string): Promise<CellOutput[]> {
        // Provide the pythonPath and ensure unbuffered output
        const options = {
            mode: 'text' as const,
            pythonPath,
            pythonOptions: ['-u']
        };

        // Inject our "globalState" into the user code
        const stateInjection = Object.entries(this.globalState)
            .map(([key, value]) => `${key} = ${JSON.stringify(value)}`)
            .join('\n');

        // We indent the user code so we can wrap it in a try/catch block
        const indentedCode = code
            .split('\n')
            .map((line) => '        ' + line)
            .join('\n');

        // This is the final code we put in the temp script
        const wrappedCode = `${PYTHON_SETUP_CODE}
${stateInjection}

stdout = io.StringIO()
stderr = io.StringIO()
sys.stdout = stdout
sys.stderr = stderr

try:
    with redirect_stdout(stdout), redirect_stderr(stderr):
${indentedCode}
        cleanup_plots()
except Exception as e:
    output_collector.add_error(e)

# restore stdout/stderr
sys.stdout = sys.__stdout__
sys.stderr = sys.__stderr__

# Collect any leftover prints
stdout_content = stdout.getvalue()
stderr_content = stderr.getvalue()
if stdout_content.strip():
    output_collector.add_text(stdout_content, 'stdout')
if stderr_content.strip():
    output_collector.add_text(stderr_content, 'stderr')

# Attempt to gather updated locals into a JSON-friendly dict
state_dict = {}
locals_copy = dict(locals().items())

def is_json_serializable(obj):
    try:
        import copy
        obj_copy = copy.deepcopy(obj)
        import json
        json.dumps(obj_copy)
        return True
    except:
        return False

for key, value in locals_copy.items():
    if not key.startswith('_') and not callable(value) and not isinstance(value, (type, types.ModuleType)):
        try:
            import copy
            import json
            value_copy = copy.deepcopy(value)
            json.dumps(value_copy)
            state_dict[key] = value_copy
        except:
            pass

print("STATE:", json.dumps(state_dict))
print("OUTPUTS:", output_collector.get_outputs())
`;

        try {
            return await new Promise<CellOutput[]>((resolve) => {
                let outputs: CellOutput[] = [];
                let newState = {};

                // We'll create a temporary .py script, write the wrapped code, then run it
                const tmpDir = process.env.TMPDIR || process.env.TMP || '/tmp';
                const scriptPath = path.join(tmpDir, `mdrun_temp_${Date.now()}.py`);
                fs.writeFileSync(scriptPath, wrappedCode);

                const pyshell = new PythonShell(scriptPath, options);

                pyshell.on('stderr', (stderrLine: string) => {
                    // If there is any direct stderr line from Python Shell 
                    console.error('Python stderr:', stderrLine);
                });

                pyshell.on('message', (message: string) => {
                    if (!message.trim()) return;
                    
                    // The script prints two special lines:
                    //   "STATE: {...}" and "OUTPUTS: [...]"
                    if (message.startsWith('STATE:')) {
                        const jsonStr = message.slice(6).trim();
                        try {
                            const parsed = JSON.parse(jsonStr);
                            newState = { ...this.globalState, ...parsed };
                        } catch (e) {
                            console.error('Failed to parse STATE JSON:', e);
                        }
                    } else if (message.startsWith('OUTPUTS:')) {
                        const jsonStr = message.slice(8).trim();
                        try {
                            outputs = JSON.parse(jsonStr);
                        } catch (e) {
                            console.error('Failed to parse OUTPUTS JSON:', e);
                        }
                    } else {
                        // Some other line that doesn't match STATE or OUTPUTS
                        console.log('Python message:', message);
                    }
                });

                pyshell.on('error', (err) => {
                    console.error('PythonShell error:', err);
                    // Return an error output
                    resolve([
                        {
                            type: 'error',
                            timestamp: Date.now(),
                            error: err.message,
                            traceback: []
                        }
                    ]);
                });

                // When done, remove temp file and update global state
                pyshell.on('close', () => {
                    try {
                        fs.unlinkSync(scriptPath);
                    } catch (unlinkErr) {
                        console.error('Failed to delete temp script:', unlinkErr);
                    }
                    // Update global state with new variables
                    this.globalState = newState;
                    resolve(outputs);
                });

                // If something else ends the shell
                pyshell.end((err: Error | null) => {
                    if (err) {
                        resolve([
                            {
                                type: 'error',
                                timestamp: Date.now(),
                                error: err.message,
                                traceback: []
                            }
                        ]);
                    }
                });
            });
        } catch (error: any) {
            console.error('Failed to execute Python code:', error);
            return [
                {
                    type: 'error',
                    timestamp: Date.now(),
                    error: error.message || String(error),
                    traceback: []
                }
            ];
        }
    }

    /**
     * Clears stored global state so that next code run starts fresh.
     */
    public clearState(): void {
        this.globalState = {};
    }

    /**
     * Optional: retrieve the current state for debugging or other uses.
     */
    public getGlobalState(): { [key: string]: any } {
        return { ...this.globalState };
    }
}
