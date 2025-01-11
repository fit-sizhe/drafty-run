import { CellOutput } from './types';
import { PythonRunner } from './pythonRunner';

// Interface for language runners
export interface ILanguageRunner {
    executeCode(
        docPath: string,
        code: string,
        envPath: string,
        blockId: string,
        onPartialOutput?: (output: CellOutput) => void
    ): Promise<{ outputs: CellOutput[] }>;
    clearState(docPath: string): void;
    disposeRunner(docPath: string): void;
    terminateExecution?(docPath: string): void; // Optional for backward compatibility
}

// Adapter to make PythonRunner match ILanguageRunner interface
export class PythonRunnerAdapter implements ILanguageRunner {
    private runners = new Map<string, PythonRunner>();
    
    private getRunner(docPath: string): PythonRunner {
        if (!this.runners.has(docPath)) {
            this.runners.set(docPath, new PythonRunner());
        }
        return this.runners.get(docPath)!;
    }

    startProcessForDoc(
        docPath: string, 
        envPath: string, 
        onDataCallback?: (output: CellOutput) => void
    ) {
        const runner = this.getRunner(docPath);
        runner.startProcessForDoc(docPath, envPath, onDataCallback);
    }

    executeCode(
        docPath: string, 
        code: string, 
        envPath: string, 
        blockId: string, 
        onPartialOutput?: (output: CellOutput) => void
    ) {
        const runner = this.getRunner(docPath);
        // Use queue-based execution
        return runner.queueCodeExecution(docPath, code, onPartialOutput);
    }

    terminateExecution(docPath: string): void {
        const runner = this.runners.get(docPath);
        if (runner) {
            runner.terminateExecution(docPath);
        }
    }

    clearState(docPath: string): void {
        const runner = this.runners.get(docPath);
        if (runner) {
            runner.clearState();
            // we don't dispose runner when click "clear"
            // runner.disposeRunner(docPath);
            // this.runners.delete(docPath);
        }
    }

    disposeRunner(docPath: string): void {
        const runner = this.runners.get(docPath);
        if (runner) {
            runner.disposeRunner(docPath);
        }
        this.runners.delete(docPath);
    }

    disposeAll(): void {
        for (const [docPath, runner] of this.runners.entries()) {
            runner.disposeRunner(docPath);
        }
        this.runners.clear();
    }    
}

// Registry for language runners
export class RunnerRegistry {
    private static instance: RunnerRegistry;
    private runners = new Map<string, ILanguageRunner>();

    private constructor() {
        // Register the Python runner by default
        const pythonAdapter = new PythonRunnerAdapter();
        this.runners.set('python', pythonAdapter);
    }

    static getInstance(): RunnerRegistry {
        if (!RunnerRegistry.instance) {
            RunnerRegistry.instance = new RunnerRegistry();
        }
        return RunnerRegistry.instance;
    }

    getRunner(language: string): ILanguageRunner | undefined {
        return this.runners.get(language.toLowerCase());
    }

    disposeAll(): void {
        for (const runner of this.runners.values()) {
            if ('disposeAll' in runner) {
                (runner as any).disposeAll();
            }
        }
        this.runners.clear();
    }
}
