import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as path from 'path';
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
sys.ps1 = ''
sys.ps2 = ''

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
        # plt.close('all')
    
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
        output_collector.add_text(repr(obj))

sys.__displayhook__ = custom_display_hook

def cleanup_plots():
    if plt.get_fignums():
        output_collector.add_image()
        plt.close('all')


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
    
    private globalState: { [key: string]: any } = {};
    private processes: Map<string, ChildProcessWithoutNullStreams> = new Map();

    constructor() {}

    // start a persistent python process per doc
    // only kill the process on doc close or session clear
    public startProcessForDoc(
        docPath: string,
        pythonPath: string,
        onDataCallback?: (partialOutput: CellOutput) => void
    ): void {

        if (this.processes.has(docPath)) {
            return;
        }

        const child = spawn(pythonPath, ['-u', '-i'], {
            cwd: path.dirname(docPath),
        });


        child.stdout.on('data', (data: Buffer) => {
            onDataCallback?.({
                type: 'text',
                timestamp: Date.now(),
                content: data.toString(),
                stream: 'stdout'
            });
        });

        child.stderr.on('data', (data: Buffer) => {
            onDataCallback?.({
                type: 'text',
                timestamp: Date.now(),
                content: data.toString(),
                stream: 'stderr'
            });
        });

        child.on('close', (code) => {
            console.log(`Python process closed with code ${code}`);
            this.processes.delete(docPath);
        });

        this.processes.set(docPath, child);
        const wrappedSetup = `exec("""${PYTHON_SETUP_CODE}""")`;
        child.stdin.write(wrappedSetup + "\n");
    }

    public executeCode(
        docPath: string,
        code: string,
        onDataCallback?: (partialOutput: CellOutput) => void
    ): Promise<{ outputs: CellOutput[] }> {
        const child = this.processes.get(docPath);
        if (!child) {
            throw new Error(`No process for docPath: ${docPath}`);
        }
    
        // Remove any prior stdout listener
        child.stdout.removeAllListeners('data');
    
        let finalOutputs: CellOutput[] = [];
        let dataBuffer = ''; // accumulate chunks here until we have complete lines
    
        const promise = new Promise<{ outputs: CellOutput[] }>((resolve, reject) => {
    
            // Handle chunks from stdout
            const onData = (chunk: Buffer) => {
                dataBuffer += chunk.toString('utf8');
                const lines = dataBuffer.split('\n');
                // last element may be incomplete, put it back into dataBuffer
                dataBuffer = lines.pop() || '';
    
                // each item in `lines` is a complete line
                for (const rawLine of lines) {
                    const line = rawLine.trim();
                    if (!line) continue;
    
                    if (line.startsWith('PARTIAL_OUTPUTS:')) {
                        // realtime partial output
                        const jsonStr = line.slice('PARTIAL_OUTPUTS:'.length).trim();
                        try {
                            const partialObj = JSON.parse(jsonStr);
                            onDataCallback?.({
                                ...partialObj,
                                timestamp: Date.now()
                            });
                        } catch (err) {
                            console.error('Failed to parse PARTIAL_OUTPUTS JSON:', err);
                        }
                    } else if (line.startsWith('OUTPUTS:')) {
                        const jsonStr = line.slice('OUTPUTS:'.length).trim();
                        try {
                            finalOutputs = JSON.parse(jsonStr);
                        } catch (err) {
                            console.error('Failed to parse OUTPUTS JSON:', err);
                        }
                    } else if (line.startsWith('STATE:')) {
                        // Done - resolve
                        console.debug('[Stream STATE]:', line);
                        child.stdout.off('data', onData);
                        // TODO: make this arm more useful
                        // not printing anything for now
                        resolve({ outputs: [] });
                    } else {
                        // Normal text
                        onDataCallback?.({
                            type: 'text',
                            timestamp: Date.now(),
                            content: line,
                            stream: 'stdout'
                        });
                    }
                }
            };
    
            child.stdout.on('data', onData);
    
            // handle stderr
            child.stderr.on('data', (chunk: Buffer) => {
                const errorLine = chunk.toString('utf8');
                onDataCallback?.({
                    type: 'text',
                    timestamp: Date.now(),
                    content: errorLine,
                    stream: 'stderr'
                });
            });
    
            child.on('close', (code) => {
                if (code !== 0) {
                    reject(new Error(`Python process exited with code ${code}`));
                } else {
                    // TODO: Optionally resolve if needed
                }
            });
        });
    
        // Base64-encode the user code
        const codeBase64 = Buffer.from(code, 'utf8').toString('base64');
    
        // wrap everything in a single exec("""...""") block
        const wrappedCode = `
exec("""import base64
decoded = base64.b64decode('${codeBase64}').decode('utf-8')
try:
    exec(decoded, globals(), globals())
    cleanup_plots()
except Exception as e:
    output_collector.add_error(e)

print('OUTPUTS:', json.dumps(output_collector._outputs))
print('STATE:', json.dumps({}))
""")`;
    
        child.stdin.write(wrappedCode + '\n');
        return promise;
    }
    
    public disposeRunner(docPath: string): void {
        const child = this.processes.get(docPath);
        if (child) {
            try {
                child.kill();
            } catch (err) {
                console.error('Error killing Python process:', err);
            }
            this.processes.delete(docPath);
        }
    }

    public disposeAll(): void {
        for (const [docPath, shell] of this.processes.entries()) {
            try {
                shell.kill();
            } catch (err) {
                console.error('Error killing Python process:', err);
            }
        }
        this.processes.clear();
    }

    public clearState(): void {
        // TODO: delete globalState altogether
        this.globalState = {};
        // this.processes.clear();
    }

    public getGlobalState(): { [key: string]: any } {
        return { ...this.globalState };
    }
}
