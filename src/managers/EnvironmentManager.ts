import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { exec } from "child_process";
import * as vscode from "vscode";

export function truncatePath(
  fullPath: string,
  maxSegments: number = 3,
): string {
  // Split on path separator:
  // For Windows, e.g. "C:\Users\John\..." => ["C:", "Users", "John", ...].
  // For Linux/macOS, e.g. "/usr/local/bin/python" => ["", "usr", "local", "bin", "python"].
  const segments = fullPath.split(path.sep).filter(Boolean);

  if (segments.length > maxSegments) {
    // Number of segments to remove
    const removeCount = segments.length - maxSegments;
    // Replace all removed segments with '$PARENT'
    segments.splice(0, removeCount, "$PARANT");
  }

  // Re-join with the platform-specific separator
  return segments.join(path.sep);
}

export interface Environment {
  label: string;
  path: string;
}

export class EnvironmentManager {
  private static instance: EnvironmentManager;
  private environments: Environment[] = [];
  private selectedPath: string = "";
  // docPath -- binary pairs
  private docBins: Map<string, string> = new Map();

  private constructor() {}

  static getInstance(): EnvironmentManager {
    if (!this.instance) {
      this.instance = new EnvironmentManager();
    }
    return this.instance;
  }

  async initialize(): Promise<void> {
    // Gather environments if not already done
    if (this.environments.length === 0) {
      this.environments = await this.gatherEnvironments();
    }

    if (this.environments.length > 0) {
      // Validate and update global selectedPath
      if (!this.selectedPath) {
        this.selectedPath = this.environments[0].path;
      }
    }
  }

  async refresh(docPath?: string): Promise<void> {
    this.environments = await this.gatherEnvironments();
    if (this.environments.length > 0) {
      
      const binPaths = this.environments.map((env)=>env.path);
      // reset selectedPath
      if (!binPaths.includes(this.selectedPath)) {
        this.selectedPath = binPaths[0];
      }
      // if binary for current doc no longer exists, 
      // set it to the first found path
      if (docPath) {
        const curBin = this.getSelectedBin(docPath);
        if (!binPaths.includes(curBin)) {
          this.setSelectedPath(binPaths[0], docPath);
        }
      }
    }
  }

  getEnvironments(): Environment[] {
    return this.environments;
  }

  getSelectedBin(docPath?: string): string {
    if (docPath) {
      let binPath = this.docBins.get(docPath);
      if (binPath) return binPath;
    }
    return this.selectedPath;
  }

  setSelectedPath(path: string, docPath?: string): void {
    this.selectedPath = path
    if (docPath) {
      this.docBins.set(docPath, path);
    }
  }

  private async gatherEnvironments(): Promise<Environment[]> {
    const results: Environment[] = [];

    vscode.window.setStatusBarMessage("Drafty: Looking for Python Envs", 2000);
    
    // Run all environment detection methods in parallel for better performance
    const [condaEnvs, venvs, projectVenvs, systemPythons] = await Promise.all([
      this.listCondaEnvs(),
      Promise.resolve(this.listVirtualenvs()),
      Promise.resolve(this.listProjectVenvs()),
      this.listSystemPythons()
    ]);
    
    results.push(...condaEnvs);
    results.push(...venvs);
    results.push(...projectVenvs);
    results.push(...systemPythons);
    vscode.window.setStatusBarMessage("Drafty: Done with Env Search", 3000);
    // If none found, fallback to "python3" or "python.exe" on Windows
    if (results.length === 0) {
      if (process.platform === "win32") {
        results.push({
          label: "Default: python.exe",
          path: "python.exe",
        });
      } else {
        results.push({
          label: "Default: python3",
          path: "python3",
        });
      }
    }

    // Remove duplicates by path
    const unique = new Map<string, Environment>();
    for (const env of results) {
      unique.set(env.path, env);
    }
    return Array.from(unique.values());
  }

  /**
   * Attempt to list system python installations by calling:
   *   - "where python" on Windows
   *   - "which -a python3 python" on macOS/Linux
   */
  private async listSystemPythons(): Promise<Environment[]> {
    return new Promise((resolve) => {
      const isWindows = process.platform === "win32";
      const results: Environment[] = [];
      
      // On Unix, tries both python3 and python
      const cmd = isWindows ? "where python" : "which -a python3 python"; 

      exec(cmd, (error, stdout) => {
        if (!error) {
          // Split lines
          const lines = stdout.trim().split(/\r?\n/);
          for (const line of lines) {
            if (fs.existsSync(line)) {
              const parentDir = path.basename(path.dirname(line));
              const binName = path.basename(line);
              results.push({
                label: `System [${parentDir}]: ${binName}`,
                path: line,
              });
            }
          }
        }
        resolve(results);
      });
    });
  }

  // Scan for .venv folders in project root and parent directories
  private listProjectVenvs(): Environment[] {
    const out: Environment[] = [];
    const isWindows = process.platform === "win32";
    
    // Get workspace folders or current working directory
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const searchPaths: string[] = [];
    
    if (workspaceFolders) {
      // Add workspace root directories
      searchPaths.push(...workspaceFolders.map(folder => folder.uri.fsPath));
    } else {
      // Fallback to current working directory
      searchPaths.push(process.cwd());
    }
    
    // For each workspace/directory, check current and parent directories
    for (const basePath of searchPaths) {
      let currentPath = basePath;
      const maxLevels = 3; // Don't go too high up the directory tree
      
      for (let level = 0; level < maxLevels; level++) {
        const venvPath = path.join(currentPath, ".venv");
        
        if (fs.existsSync(venvPath) && fs.statSync(venvPath).isDirectory()) {
          const pythonPath = isWindows
            ? path.join(venvPath, "Scripts", "python.exe")
            : path.join(venvPath, "bin", "python");
            
          if (fs.existsSync(pythonPath)) {
            const projectName = path.basename(currentPath);
            out.push({
              label: `project venv: ${projectName}`,
              path: pythonPath,
            });
          }
        }
        
        // Move up one directory level
        const parentPath = path.dirname(currentPath);
        if (parentPath === currentPath) {
          // Reached filesystem root
          break;
        }
        currentPath = parentPath;
      }
    }
    
    return out;
  }

  // Scan virtualenv directories for python executables
  private listVirtualenvs(): Environment[] {
    const out: Environment[] = [];
    const homeDir = os.homedir();
    const platform = process.platform;
    const isWindows = platform === "win32";

    // Define potential venv locations based on OS
    const venvLocations: string[] = [];

    if (isWindows) {
      // Windows: check %USERPROFILE%\Envs
      venvLocations.push(path.join(homeDir, "Envs"));
    } else if (platform === "darwin") {
      // macOS: check multiple typical locations
      const pythonVersions = ["3.7", "3.8", "3.9", "3.10", "3.11", "3.12"];
      pythonVersions.forEach((version) => {
        venvLocations.push(
          path.join(
            homeDir,
            "Library",
            "Python",
            version,
            "lib",
            "python",
            "site-packages",
          ),
        );
      });
      venvLocations.push(path.join(homeDir, ".virtualenvs"));
    } else {
      // Linux: check ~/.virtualenvs
      venvLocations.push(path.join(homeDir, ".virtualenvs"));
    }

    // Check each potential location
    for (const venvFolder of venvLocations) {
      if (fs.existsSync(venvFolder) && fs.statSync(venvFolder).isDirectory()) {
        const subdirs = fs.readdirSync(venvFolder, { withFileTypes: true });
        for (const d of subdirs) {
          if (d.isDirectory()) {
            const envName = d.name;
            const pythonPath = isWindows
              ? path.join(venvFolder, envName, "Scripts", "python.exe")
              : path.join(venvFolder, envName, "bin", "python");

            if (fs.existsSync(pythonPath)) {
              out.push({
                label: `venv: ${envName}`,
                path: pythonPath,
              });
            }
          }
        }
      }
    }
    return out;
  }

  // Identify conda envs by running conda env list --json
  private async listCondaEnvs(): Promise<Environment[]> {
    return new Promise(async (resolve) => {
      const isWindows = process.platform === "win32";

      if (isWindows) {
        const condaPath = await this.findWinConda();
        if (!condaPath) {
          // If conda is not found anywhere, just resolve([])
          console.error("Could not find conda.exe on Windows");
          return resolve([]);
        }
        // Build the command using the absolute path to conda.exe
        const cmd = `"${condaPath}" env list --json`;
        exec(cmd, (error, stdout) => {
          if (error) {
            console.error("Could not run conda env list:", error);
            return resolve([]);
          }
          resolve(this.parseCondaEnvs(stdout));
        });
      } else {
        // On Unix-like systems, try to source the appropriate RC file
        const shell = await this.findShell();
        let cmd: string;
        if (shell === "zsh") {
          cmd = "source ~/.zshrc 2>/dev/null || true; conda env list --json";
        } else if (shell === "bash") {
          cmd = "source ~/.bashrc 2>/dev/null || true; conda env list --json";
        } else {
          cmd = "conda env list --json"; // fallback for 'sh'
        }
        const options = { shell };
        exec(cmd, options, (error, stdout) => {
          if (error) {
            console.error("Could not run conda env list:", error);
            return resolve([]);
          }
          resolve(this.parseCondaEnvs(stdout));
        });
      }
    });
  }

  // parse conda --json output
  private parseCondaEnvs(stdout: string): Environment[] {
    try {
      const data = JSON.parse(stdout);
      if (Array.isArray(data.envs)) {
        const results: Environment[] = [];
        for (const envPath of data.envs) {
          const envName = path.basename(envPath);
          const label = `conda: ${envName}`;
          const pythonPath =
            process.platform === "win32"
              ? path.join(envPath, "python.exe")
              : path.join(envPath, "bin", "python");

          if (fs.existsSync(pythonPath)) {
            results.push({ label, path: pythonPath });
          } else {
            // fallback if python is missing
            results.push({ label, path: envPath });
          }
        }
        return results;
      }
    } catch (parseErr) {
      console.error("Failed to parse conda --json output:", parseErr);
    }
    return [];
  }

  private async findWinConda(): Promise<string | null> {
    return new Promise((resolve) => {
      // Fallback to known default locations
      const fallbackPaths = [
        path.join(os.homedir(), "anaconda3", "Scripts", "conda.exe"),
        path.join(os.homedir(), "miniconda3", "Scripts", "conda.exe"),
        "C:\\ProgramData\\Anaconda3\\Scripts\\conda.exe",
        "C:\\Program Files\\Anaconda3\\Scripts\\conda.exe",
        "C:\\Program Files (x86)\\Anaconda3\\Scripts\\conda.exe",
      ];

      for (const fp of fallbackPaths) {
        if (fs.existsSync(fp)) {
          return resolve(fp);
        }
      }
      // If not found, return null
      return resolve(null);
    });
  }

  // Find which shell to use for sourcing environment files
  private async findShell(): Promise<string> {
    if (process.platform === "win32") {
      return "cmd.exe";
    }
    return new Promise((resolve) => {
      // Try zsh first
      exec("which zsh", (error, stdout) => {
        if (!error && stdout.trim()) {
          resolve("zsh");
        } else {
          // Try bash
          exec("which bash", (error2, stdout2) => {
            if (!error2 && stdout2.trim()) {
              resolve("bash");
            } else {
              // Fallback
              resolve("sh");
            }
          });
        }
      });
    });
  }
}
