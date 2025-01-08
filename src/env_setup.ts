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
        const homeDir = os.homedir();
        const venvFolder = path.join(homeDir, '.virtualenvs');
        const out: Environment[] = [];

        if (fs.existsSync(venvFolder) && fs.statSync(venvFolder).isDirectory()) {
            const subdirs = fs.readdirSync(venvFolder, { withFileTypes: true });
            for (const d of subdirs) {
                if (d.isDirectory()) {
                    const envName = d.name;
                    const pyPath = path.join(venvFolder, envName, 'bin', 'python');
                    if (fs.existsSync(pyPath)) {
                        out.push({
                            label: `venv: ${envName}`,
                            path: pyPath
                        });
                    }
                }
            }
        }
        return out;
    }

    private listCondaEnvs(): Promise<Environment[]> {
        return new Promise((resolve) => {
            const cmd = `source ~/.zshrc && conda env list --json`;

            exec(cmd, { shell: '/bin/zsh' }, (error, stdout, stderr) => {
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
                            const pyBin = path.join(envPath, 'bin', 'python');
                            if (fs.existsSync(pyBin)) {
                                results.push({ label, path: pyBin });
                            } else {
                                const winBin = path.join(envPath, 'python.exe');
                                if (fs.existsSync(winBin)) {
                                    results.push({ label, path: winBin });
                                } else {
                                    results.push({ label, path: envPath });
                                }
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
