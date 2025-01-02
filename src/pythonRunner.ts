import { PythonShell } from 'python-shell';
import * as path from 'path';
import * as fs from 'fs';
import { CellOutput } from './types';

//
// Updated PYTHON_SETUP_CODE with real-time partial output flushing
//
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
        # Flush partial output immediately for real-time streaming:
        self._flush_partial(output)

    def _flush_partial(self, output):
        """
        Print the single newly added output as a JSON string,
        prefixed by PARTIAL_OUTPUTS: so we can detect it in the Node side.
        """
        print("PARTIAL_OUTPUTS:" + json.dumps(output))

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
    # If there are any active figures, convert them to images
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
     * Allows partial streaming by calling onDataCallback with text lines as they arrive.
     * Returns both the outputs and the pyshell instance for process management.
     */
    public async executeCode(
        code: string,
        pythonPath: string,
        blockId: string,
        onDataCallback?: (partialOutput: CellOutput) => void
    ): Promise<{outputs: CellOutput[], pyshell: PythonShell}> {
        const options = {
            mode: 'text' as const,
            pythonPath,
            pythonOptions: ['-u'] // -u = unbuffered (helps streaming)
        };

        // Inject "globalState" into the user code
        const stateInjection = Object.entries(this.globalState)
            .map(([key, value]) => `${key} = ${JSON.stringify(value)}`)
            .join('\n');

        // Indent user code
        const indentedCode = code
            .split('\n')
            .map((line) => '    ' + line)
            .join('\n');

        // Final code
        const wrappedCode = `${PYTHON_SETUP_CODE}
${stateInjection}

# stdout = io.StringIO()
# stderr = io.StringIO()
# sys.stdout = stdout
# sys.stderr = stderr

try:
#     with redirect_stdout(stdout), redirect_stderr(stderr):
${indentedCode}
    cleanup_plots()
except Exception as e:
    output_collector.add_error(e)

# restore stdout/stderr
# sys.stdout = sys.__stdout__
# sys.stderr = sys.__stderr__

# Collect any leftover prints
# stdout_content = stdout.getvalue()
# stderr_content = stderr.getvalue()
# if stdout_content.strip():
#     output_collector.add_text(stdout_content, 'stdout')
# if stderr_content.strip():
#     output_collector.add_text(stderr_content, 'stderr')
 
# Attempt to gather updated locals
state_dict = {}
locals_copy = dict(locals().items())

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

        return await new Promise((resolve) => {
            let outputs: CellOutput[] = [];
            let newState: { [key: string]: any } = {};

            // Create a temporary .py script
            const tmpDir = process.env.TMPDIR || process.env.TMP || '/tmp';
            const scriptPath = path.join(tmpDir, `mdrun_temp_${Date.now()}.py`);
            fs.writeFileSync(scriptPath, wrappedCode);

            const pyshell = new PythonShell(scriptPath, options);

            pyshell.on('stderr', (stderrLine: string) => {
                // Streams on stderr come line by line
                console.debug('[Stream stderr]:', stderrLine);
                if (onDataCallback) {
                    onDataCallback({
                        type: 'text',
                        timestamp: Date.now(),
                        content: stderrLine.trimEnd(),
                        stream: 'stderr'
                    });
                }
            });

            // Each line from stdout is passed to .on('message', ...)
            // We'll parse "STATE:", "OUTPUTS:", or "PARTIAL_OUTPUTS:" 
            // or treat them as partial lines
            pyshell.on('message', (message: string) => {
                if (!message.trim()) return;

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
                } else if (message.startsWith('PARTIAL_OUTPUTS:')) {
                    // Real-time partial output from output_collector
                    console.debug('[Stream Partial]:', message);
                    const jsonStr = message.slice('PARTIAL_OUTPUTS:'.length).trim();
                    try {
                        const partialObj = JSON.parse(jsonStr);
                        if (onDataCallback) {
                            // Provide the partial output to callback
                            // partialObj already has e.g. "type", "content", etc.
                            onDataCallback({
                                ...partialObj,
                                // Optionally override the timestamp with "now"
                                timestamp: Date.now()
                            });
                        }
                    } catch (err) {
                        console.error('Failed to parse PARTIAL_OUTPUTS JSON:', err);
                    }
                } else {
                    // Just a normal partial line from stdout
                    console.debug('[Stream stdout]:', message);
                    if (onDataCallback) {
                        onDataCallback({
                            type: 'text',
                            timestamp: Date.now(),
                            content: message,
                            stream: 'stdout'
                        });
                    }
                }
            });

            pyshell.on('error', (err) => {
                console.error('PythonShell error:', err);
                resolve({
                    outputs: [{
                        type: 'error',
                        timestamp: Date.now(),
                        error: err.message,
                        traceback: []
                    }],
                    pyshell
                });
            });

            pyshell.on('close', () => {
                // Remove temp file
                try {
                    fs.unlinkSync(scriptPath);
                } catch (unlinkErr) {
                    console.error('Failed to delete temp script:', unlinkErr);
                }
                // Update global state
                this.globalState = newState;
                resolve({ outputs, pyshell });
            });

            // End the shell.  (We'll rely on 'close' event to finalize.)
            pyshell.end((err: Error | null) => {
                if (err) {
                    resolve({
                        outputs: [{
                            type: 'error',
                            timestamp: Date.now(),
                            error: err.message,
                            traceback: []
                        }],
                        pyshell
                    });
                }
            });
        });
    }

    public clearState(): void {
        this.globalState = {};
    }

    public getGlobalState(): { [key: string]: any } {
        return { ...this.globalState };
    }
}
