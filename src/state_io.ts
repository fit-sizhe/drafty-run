import * as fs from 'fs';
import * as path from 'path';
import { CodeBlockExecution } from './types';

export interface SessionState {
    codeBlocks: Map<string, CodeBlockExecution>;
    currentBlockIndex: number;
    runCount: number;
}

export class StateManager {
    private static instance: StateManager;
    private currentState: SessionState | undefined;

    private constructor() {}

    static getInstance(): StateManager {
        if (!this.instance) {
            this.instance = new StateManager();
        }
        return this.instance;
    }

    getCurrentState(): SessionState | undefined {
        return this.currentState;
    }

    setCurrentState(state: SessionState): void {
        this.currentState = state;
    }

    clearState(): void {
        this.currentState = undefined;
    }

    // Try to load the most recent JSON state for the given .md file
    tryLoadPreviousState(mdFullPath: string): SessionState | undefined {
        const dir = path.dirname(mdFullPath);
        const baseName = path.basename(mdFullPath, '.md');
        const re = new RegExp(`^${baseName}-state-(\\d{8})-(\\d{4})\\.json$`);

        if (!fs.existsSync(dir)) {
            return undefined;
        }
        const files = fs.readdirSync(dir).filter((f) => re.test(f));
        if (files.length === 0) {
            return undefined;
        }

        // Sort files by date/time descending
        files.sort((a, b) => {
            const matchA = a.match(re)!;
            const matchB = b.match(re)!;
            const dateA = matchA[1] + matchA[2]; // yyyymmddhhmm
            const dateB = matchB[1] + matchB[2];
            return dateB.localeCompare(dateA); // descending
        });

        const latestFile = path.join(dir, files[0]);
        try {
            const raw = fs.readFileSync(latestFile, 'utf-8');
            const savedState = JSON.parse(raw);
            return this.deserializeSessionState(savedState);
        } catch (err) {
            console.error('Failed to load previous state:', err);
            return undefined;
        }
    }

    // Save current state to a JSON file
    saveCurrentState(mdFullPath: string): string {
        if (!this.currentState) {
            throw new Error('No session state to save.');
        }

        const baseName = path.basename(mdFullPath, '.md');
        const now = new Date();
        const yyyymmdd = now.toISOString().slice(0, 10).replace(/-/g, '');
        const hhmm = String(now.getHours()).padStart(2, '0') + 
                    String(now.getMinutes()).padStart(2, '0');
        const fileName = `${baseName}-state-${yyyymmdd}-${hhmm}.json`;
        const defaultFolder = path.dirname(mdFullPath);
        const fullSavePath = path.join(defaultFolder, fileName);

        const dataToSave = this.serializeSessionState(this.currentState);
        fs.writeFileSync(fullSavePath, JSON.stringify(dataToSave, null, 2), 'utf-8');

        return fullSavePath;
    }

    private serializeSessionState(state: SessionState): any {
        const blocksArray = Array.from(state.codeBlocks.entries()).map(([blockId, exec]) => ({
            blockId,
            content: exec.content,
            info: exec.info,
            position: exec.position,
            metadata: exec.metadata,
            outputs: exec.outputs
        }));
        return {
            currentBlockIndex: state.currentBlockIndex,
            runCount: state.runCount,
            codeBlocks: blocksArray
        };
    }

    private deserializeSessionState(savedObj: any): SessionState {
        const blockMap = new Map<string, CodeBlockExecution>();
        for (const item of savedObj.codeBlocks) {
            blockMap.set(item.blockId, {
                content: item.content,
                info: item.info,
                position: item.position,
                metadata: item.metadata,
                outputs: item.outputs
            });
        }
        return {
            currentBlockIndex: savedObj.currentBlockIndex,
            runCount: savedObj.runCount,
            codeBlocks: blockMap
        };
    }
}
