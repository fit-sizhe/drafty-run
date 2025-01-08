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

# Configure matplotlib for a non-interactive backend
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
        Print only the newly added output as a JSON string,
        prefixed by PARTIAL_OUTPUTS: so the Node side can detect it.
        """
        print("PARTIAL_OUTPUTS:" + json.dumps(output))

    def add_text(self, text: str, stream: str = 'stdout'):
        if text.strip():
            self._add_output('text', content=text.strip(), stream=stream)
    
    def add_image(self, format: str = 'png', **kwargs):
        """
        Capture all open figures, encode them, and send them as partial output.
        If you want to close them right after capturing, uncomment plt.close('all').
        """
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
        # plt.close('all')  # Optionally close figures if desired.
    
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
    """
    If there are any active figures at the end, convert them to images.
    """
    if plt.get_fignums():
        output_collector.add_image()
        plt.close('all')


############################################################
#   REAL-TIME MATPLOTLIB PATCHES
############################################################

_original_pause = plt.pause

def _realtime_show(*args, **kwargs):
    # Capture as partial output
    if plt.get_fignums():
        output_collector.add_image()
    # If you prefer to close after each show, uncomment:
    # plt.close('all')

def _realtime_pause(interval):
    # Original pause
    _original_pause(interval)
    # capture as partial output
    if plt.get_fignums():
        output_collector.add_image()
    # If you prefer to close after each pause, uncomment:
    # plt.close('all')

# Monkey-patch show and pause for real-time streaming
plt.show = _realtime_show
plt.pause = _realtime_pause



`;

export class PythonRunner {
    
    // We'll store a "globalState" to allow basic retention of variables across runs.
    private globalState: { [key: string]: any } = {};

    constructor() {}


    /**
     * Executes `code` in a temporary Python script using the specified `pythonPath`.
     * Allows partial streaming by calling onDataCallback with text lines (or images) as they arrive.
     * Returns both the outputs and the pyshell instance for process management.
     */
    public executeCode(
        code: string,
        pythonPath: string,
        blockId: string,
        onDataCallback?: (partialOutput: CellOutput) => void
    ): { 
        process: PythonShell,
        promise: Promise<{ outputs: CellOutput[] }>
    } {
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

        // Final wrapped code
        const wrappedCode = `${PYTHON_SETUP_CODE}
${stateInjection}

try:
${indentedCode}
    cleanup_plots()
except Exception as e:
    output_collector.add_error(e)

# Attempt to gather updated locals into JSON
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

        // Create a temporary .py script
        const tmpDir = process.env.TMPDIR || process.env.TMP || '/tmp';
        const scriptPath = path.join(tmpDir, `mdrun_temp_${Date.now()}.py`);
        fs.writeFileSync(scriptPath, wrappedCode);

        // Launch the Python process
        const pyshell = new PythonShell(scriptPath, options);

        // Build a promise that will resolve with the final outputs
        const promise = new Promise<{ outputs: CellOutput[] }>((resolve) => {
            let outputs: CellOutput[] = [];
            let newState: { [key: string]: any } = {};

            pyshell.on('stderr', (stderrLine: string) => {
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
                    // Real-time partial output from OutputCollector
                    console.debug('[Stream Partial]:', message);
                    const jsonStr = message.slice('PARTIAL_OUTPUTS:'.length).trim();
                    try {
                        const partialObj = JSON.parse(jsonStr);
                        if (onDataCallback) {
                            onDataCallback({
                                ...partialObj,
                                timestamp: Date.now()
                            });
                        }
                    } catch (err) {
                        console.error('Failed to parse PARTIAL_OUTPUTS JSON:', err);
                    }
                } else {
                    // Normal line from stdout
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
                    }]
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
                // Finally, resolve with aggregated outputs
                resolve({ outputs });
            });
        });

        // Return both the pyshell (for immediate termination) and
        // a promise that yields the final outputs when done.
        return { process: pyshell, promise };
    }

    public clearState(): void {
        this.globalState = {};
    }

    public getGlobalState(): { [key: string]: any } {
        return { ...this.globalState };
    }
}
