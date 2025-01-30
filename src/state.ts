import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { CodeBlockExecution } from "./types";

const CONFIG_SECTION = "drafty";
const DEFAULT_PATH_KEY = "defaultPath";
const SAVING_RULE_KEY = "savingRule";

export interface SessionState {
  codeBlocks: Map<string, CodeBlockExecution>;
  runCount: number;
  bellyGroups?: string[]; // order of belly groups
}

export interface LoadResult {
  session: SessionState;
  filePath: string;
}

export class StateManager {
  private static instance: StateManager;

  private sessions: Map<string, SessionState> = new Map();

  private constructor() {}

  static getInstance(): StateManager {
    if (!this.instance) {
      this.instance = new StateManager();
    }
    return this.instance;
  }

  hasSession(docPath: string): boolean {
    return this.sessions.has(docPath);
  }

  getSession(docPath: string): SessionState | undefined {
    return this.sessions.get(docPath);
  }

  setSession(docPath: string, state: SessionState): void {
    this.sessions.set(docPath, state);
  }

  clearAllSessions(): void {
    this.sessions.clear();
  }

  removeSession(docPath: string): void {
    this.sessions.delete(docPath);
  }

  clearSession(docPath: string): void {
    const session = this.sessions.get(docPath);
    if (session) {
      session.runCount = 0;
      session.codeBlocks = new Map();
      session.bellyGroups = [];
    }
  }

  saveSession(mdFullPath: string) {
    const session = this.getSession(mdFullPath);
    if(!session) {
      vscode.window.showErrorMessage(
        "No session to save. Please run or load results first.",
      );
      return "";
    };
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const baseName = path.basename(mdFullPath, ".md");
    const now = new Date();
    const yyyymmdd = now.toISOString().slice(0, 10).replace(/-/g, "");
    const hhmm =
      String(now.getHours()).padStart(2, "0") +
      String(now.getMinutes()).padStart(2, "0");
    const fileName = `${baseName}-state-${yyyymmdd}-${hhmm}.json`;

    // save file to default path if it is set up in settings.json
    // the path is relevant to current workspace root
    const docDir = path.dirname(mdFullPath);
    let saveDir = config.get<string>(DEFAULT_PATH_KEY);
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if(workspaceRoot && saveDir){
      saveDir = path.resolve(workspaceRoot, saveDir);
    } else saveDir = docDir;
    const fullSavePath = path.join(saveDir, fileName);
    const savingRule = config.get<string>(SAVING_RULE_KEY,"keep-all");

    // delete all old state json files if saving rule is set to "latest-only"
    if (savingRule == "latest-only" && fs.existsSync(saveDir)) {
      const re = new RegExp(`^${baseName}-state-(\\d{8})-(\\d{4})\\.json$`);
      const files = fs.readdirSync(saveDir).filter((f) => re.test(f));
      for (const f of files) {
        fs.rmSync(path.join(saveDir,f));
      }
    }

    try {
      const dataToSave = this.serializeSessionState(session);
      fs.writeFileSync(
        fullSavePath,
        JSON.stringify(dataToSave, null, 2),
        "utf-8",
      );
    } catch(err) {
      vscode.window.showErrorMessage(`Failed to save JSON: ${err}`);
      return "";
    }

    return fullSavePath;
  }

  // Try to load the most recent JSON state for the given .md file
  tryLoadPreviousState(mdFullPath: string): LoadResult | undefined {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);

    // find path to saved state json files
    let dir =config.get<string>(DEFAULT_PATH_KEY);
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (dir && workspaceRoot) {
      dir = path.resolve(workspaceRoot, dir);
    } else dir =  path.dirname(mdFullPath);

    const baseName = path.basename(mdFullPath, ".md");
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
      const raw = fs.readFileSync(latestFile, "utf-8");
      const savedState = JSON.parse(raw);
      return {
        session: this.deserializeSessionState(savedState),
        filePath: latestFile,
      };
    } catch (err) {
      console.error("Failed to load previous state:", err);
      return undefined;
    }
  }

  serializeSessionState(state: SessionState): any {
    const blocksArray = Array.from(state.codeBlocks.entries()).map(
      ([bindingId, exec]) => ({
        bindingId,
        content: exec.content,
        info: exec.info,
        position: exec.position,
        metadata: exec.metadata,
        outputs: exec.outputs,
      }),
    );
    return {
      runCount: state.runCount,
      codeBlocks: blocksArray,
      bellyGroups: state.bellyGroups
    };
  }

  deserializeSessionState(savedObj: any): SessionState {
    const blockMap = new Map<string, CodeBlockExecution>();
    for (const item of savedObj.codeBlocks) {
      blockMap.set(item.bindingId, {
        bindingId: item.bindingId,
        content: item.content,
        info: item.info,
        position: item.position,
        metadata: item.metadata,
        outputs: item.outputs,
      });
    }
    return {
      runCount: savedObj.runCount,
      codeBlocks: blockMap,
      bellyGroups: savedObj.bellyGroups
    };
  }
}
