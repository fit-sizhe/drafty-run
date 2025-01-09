import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { exec } from 'child_process';

export interface Environment {
    label: string;
    path: string;
}

export class EnvironmentManager {
    private static instance: EnvironmentManager;
    private environments: Environment[] = [];
    private selectedPath: string = 'python3';

    private constructor() {}

    static getInstance(): EnvironmentManager {
        if (!this.instance) {
            this.instance = new EnvironmentManager();
        }
        return this.instance;
    }

    async initialize(): Promise<void> {
        this.environments = await this.gatherEnvironments();
        if (this.environments.length > 0) {
            this.selectedPath = this.environments[0].path;
        }
    }

    getEnvironments(): Environment[] {
        return this.environments;
    }

    getSelectedPath(): string {
        return this.selectedPath;
    }

    setSelectedPath(path: string): void {
        this.selectedPath = path;
    }

    private async gatherEnvironments(): Promise<Environment[]> {
        const results: Environment[] = [];

        // 1) Gather from conda env list
        const condaEnvs = await this.listCondaEnvs();
        results.push(...condaEnvs);

        // 2) Gather from ~/.virtualenvs
        const venvs = this.listVirtualenvs();
        results.push(...venvs);

        // If none found, fallback to "python3"
        if (results.length === 0) {
            results.push({
                label: 'Default: python3',
                path: 'python3'
            });
        }
        return results;
    }

    private listVirtualenvs(): Environment[] {
        const out: Environment[] = [];
        const homeDir = os.homedir();
        const platform = process.platform;
        const isWindows = platform === 'win32';
        
        // Define potential venv locations based on OS
        const venvLocations: string[] = [];
        
        if (isWindows) {
            // Windows: check %USERPROFILE%\Envs
            venvLocations.push(path.join(homeDir, 'Envs'));
        } else if (platform === 'darwin') {
            // macOS: check ~/Library/Python/[version]/lib/python/site-packages
            // Also check ~/.virtualenvs for compatibility
            const pythonVersions = ['3.7', '3.8', '3.9', '3.10', '3.11', '3.12'];
            pythonVersions.forEach(version => {
                venvLocations.push(path.join(homeDir, 'Library', 'Python', version, 'lib', 'python', 'site-packages'));
            });
            venvLocations.push(path.join(homeDir, '.virtualenvs'));
        } else {
            // Linux: check ~/.virtualenvs
            venvLocations.push(path.join(homeDir, '.virtualenvs'));
        }

        // Check each potential location
        for (const venvFolder of venvLocations) {
            if (fs.existsSync(venvFolder) && fs.statSync(venvFolder).isDirectory()) {
                const subdirs = fs.readdirSync(venvFolder, { withFileTypes: true });
                for (const d of subdirs) {
                    if (d.isDirectory()) {
                        const envName = d.name;
                        const pythonPath = isWindows
                            ? path.join(venvFolder, envName, 'Scripts', 'python.exe')
                            : path.join(venvFolder, envName, 'bin', 'python');

                        if (fs.existsSync(pythonPath)) {
                            out.push({
                                label: `venv: ${envName}`,
                                path: pythonPath
                            });
                        }
                    }
                }
            }
        }
        return out;
    }

    private async findShell(): Promise<string> {
        if (process.platform === 'win32') {
            return 'cmd.exe';
        }
        
        // Try to find zsh or bash
        return new Promise((resolve) => {
            // Try zsh first
            exec('which zsh', (error, stdout) => {
                if (!error && stdout.trim()) {
                    resolve("zsh");
                } else {
                    // Try bash if zsh not found
                    exec('which bash', (error, stdout) => {
                        if (!error && stdout.trim()) {
                            resolve("bash");
                        } else {
                            // Fallback to sh if neither found
                            resolve('sh');
                        }
                    });
                }
            });
        });
    }

    private listCondaEnvs(): Promise<Environment[]> {
        return new Promise(async (resolve) => {
            const shell = await this.findShell();

            // Build the command based on shell type
            let cmd: string;
            const isWindows = process.platform === 'win32';
            
            if (isWindows) {
                cmd = 'conda env list --json';
            } else {
                // On Unix-like systems, try to source the appropriate RC file
                if (shell === 'zsh') {
                    cmd = 'source ~/.zshrc 2>/dev/null || true; conda env list --json';
                } else if (shell === 'bash') {
                    cmd = 'source ~/.bashrc 2>/dev/null || true; conda env list --json';
                } else {
                    cmd = 'conda env list --json'; // fallback for sh
                }
            }
            
            const options = { shell };

            exec(cmd, options, (error, stdout, stderr) => {
                if (error) {
                    console.error('Could not run conda env list:', error);
                    return resolve([]);
                }
                try {
                    const data = JSON.parse(stdout);
                    if (Array.isArray(data.envs)) {
                        const results: Environment[] = [];
                        for (const envPath of data.envs) {
                            const envName = path.basename(envPath);
                            const label = `conda: ${envName}`;
                            const isWindows = process.platform === 'win32';
                            let pythonPath;
                            
                            if (isWindows) {
                                pythonPath = path.join(envPath, 'python.exe');
                            } else {
                                pythonPath = path.join(envPath, 'bin', 'python');
                            }

                            if (fs.existsSync(pythonPath)) {
                                results.push({ label, path: pythonPath });
                            } else {
                                // Fallback to environment path if python executable not found
                                results.push({ label, path: envPath });
                            }
                        }
                        return resolve(results);
                    }
                } catch (parseErr) {
                    console.error('Failed to parse conda --json output:', parseErr);
                }
                return resolve([]);
            });
        });
    }
}
