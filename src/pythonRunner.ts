import { PythonShell } from 'python-shell';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { TextOutput, ImageOutput, ErrorOutput, RichOutput, CellOutput } from './types';

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

# Create fresh output collector for each execution
output_collector = OutputCollector()
output_collector._outputs = []  # Reset outputs

# Setup display hook for rich output
def custom_display_hook(obj):
    if obj is not None:
        # Convert to string and add as text output
        output_collector.add_text(repr(obj))

sys.__displayhook__ = custom_display_hook

# Capture any remaining plots on exit
def cleanup_plots():
    if plt.get_fignums():
        output_collector.add_image()
        plt.close('all')
`;

export class PythonRunner {
    private static instance: PythonRunner;
    private shell: PythonShell | undefined;
    private globalState: { [key: string]: any } = {};

    private constructor() {}

    static getInstance(): PythonRunner {
        if (!PythonRunner.instance) {
            PythonRunner.instance = new PythonRunner();
        }
        return PythonRunner.instance;
    }

    async executeCode(code: string): Promise<CellOutput[]> {
        const options = {
            mode: 'text' as const,
            pythonPath: 'python3',
            pythonOptions: ['-u'], // unbuffered output
        };

        // Inject global state into code
        const stateInjection = Object.entries(this.globalState)
            .map(([key, value]) => `${key} = ${JSON.stringify(value)}`)
            .join('\n');

        // Indent user code for proper Python syntax
        const indentedCode = code.split('\n').map(line => '        ' + line).join('\n');

        // Wrap user code with setup and state management
        const wrappedCode = `${PYTHON_SETUP_CODE}
${stateInjection}

# Create fresh string buffers for each execution
stdout = io.StringIO()
stderr = io.StringIO()
sys.stdout = stdout  # Ensure print statements are captured
sys.stderr = stderr

try:
    with redirect_stdout(stdout), redirect_stderr(stderr):
${indentedCode}
        cleanup_plots()  # Capture any remaining plots
except Exception as e:
    output_collector.add_error(e)

# Reset stdout/stderr and add captured output
sys.stdout = sys.__stdout__
sys.stderr = sys.__stderr__
stdout_content = stdout.getvalue()
stderr_content = stderr.getvalue()
if stdout_content.strip():
    output_collector.add_text(stdout_content, 'stdout')
if stderr_content.strip():
    output_collector.add_text(stderr_content, 'stderr')

# Update global state
state_dict = {}
locals_copy = dict(locals().items())  # Create a copy of locals

def is_json_serializable(obj):
    """Check if an object is JSON serializable and contains only simple types."""
    try:
        # Try to create a deep copy to break circular references
        obj_copy = copy.deepcopy(obj)
        # Try to serialize the copy
        json.dumps(obj_copy)
        return True
    except:
        return False

for key, value in locals_copy.items():
    # Skip internal Python objects and non-serializable values
    if (not key.startswith('_') and 
        not callable(value) and 
        not isinstance(value, (type, types.ModuleType))):
        try:
            # Try to create a deep copy to break circular references
            value_copy = copy.deepcopy(value)
            # Try to serialize the copy
            json.dumps(value_copy)
            state_dict[key] = value_copy
        except:
            pass  # Skip values that can't be copied or serialized

print("STATE:", json.dumps(state_dict))
print("OUTPUTS:", output_collector.get_outputs())`;

        try {
            return new Promise<CellOutput[]>((resolve, reject) => {
                let outputs: CellOutput[] = [];
                let newState = {};

                // Create a temporary script file
                // Create temp file in the OS temporary directory
                const tmpDir = process.env.TMPDIR || process.env.TMP || '/tmp';
                const scriptPath = path.join(tmpDir, `mdrun_temp_${Date.now()}.py`);
                console.log('Creating temporary script at:', scriptPath);
                fs.writeFileSync(scriptPath, wrappedCode);
                console.log('Executing Python code...');
                const pyshell = new PythonShell(scriptPath, options);

                pyshell.on('stderr', (err) => {
                    console.error('Python stderr:', err);
                });

                pyshell.on('message', (message: string) => {
                    console.log('Python message:', message);
                    if (!message.trim()) return;  // Skip empty messages
                    if (message.startsWith('STATE:')) {
                        try {
                            const stateData = JSON.parse(message.slice(6));
                            newState = { ...this.globalState, ...stateData };
                        } catch (e) {
                            console.error('Failed to parse state:', e);
                        }
                    } else if (message.startsWith('OUTPUTS:')) {
                        try {
                            outputs = JSON.parse(message.slice(8));
                        } catch (e) {
                            console.error('Failed to parse outputs:', e);
                        }
                    }
                });

                pyshell.on('error', (error: Error) => {
                    console.error('Python error:', error);
                    resolve([{
                        type: 'error' as const,
                        timestamp: Date.now(),
                        error: error.message,
                        traceback: []
                    }]);
                });

                pyshell.on('close', () => {
                    // Clean up temporary file
                    try {
                        fs.unlinkSync(scriptPath);
                    } catch (e) {
                        console.error('Failed to delete temporary script:', e);
                    }
                    this.globalState = newState;
                    resolve(outputs);
                });

                pyshell.end((err: Error | null) => {
                    if (err) {
                        resolve([{
                            type: 'error' as const,
                            timestamp: Date.now(),
                            error: err.message,
                            traceback: []
                        }]);
                    }
                });
            });
        } catch (error: unknown) {
            console.error('Failed to execute Python code:', error);
            return [{
                type: 'error' as const,
                timestamp: Date.now(),
                error: error instanceof Error ? error.message : String(error),
                traceback: []
            }];
        }
    }

    getGlobalState(): { [key: string]: any } {
        return { ...this.globalState };
    }

    clearState(): void {
        this.globalState = {};
    }
}
