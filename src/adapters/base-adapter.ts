import * as cp from 'child_process';
import { AgentId } from '../types.js';

export interface AdapterExecutionResult {
  success: boolean;
  output: string;
  error?: string;
  durationMs: number;
}

export abstract class BaseAdapter {
  abstract readonly id: AgentId;
  abstract readonly name: string;
  abstract readonly command: string;

  public runProcess(
    args: string[],
    options: {
      timeoutMs?: number;
      input?: string;
      cwd?: string;
    } = {}
  ): Promise<AdapterExecutionResult> {
    const isWin = process.platform === 'win32';
    const start = Date.now();
    const timeoutMs = options.timeoutMs || 180_000;

    let file: string;
    let finalArgs: string[];

    if (isWin) {
      file = 'cmd.exe';
      finalArgs = ['/d', '/s', '/c', this.command, ...args];
    } else {
      file = this.command;
      finalArgs = args;
    }

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let isSettled = false;

      const child = cp.spawn(file, finalArgs, {
        cwd: options.cwd || process.cwd(),
        stdio: [options.input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        windowsVerbatimArguments: isWin
      });

      const timer = setTimeout(() => {
        if (!isSettled) {
          isSettled = true;
          try { child.kill('SIGKILL'); } catch {}
          resolve({
            success: false,
            output: '',
            error: `Timeout: ${this.name} exceeded ${timeoutMs / 1000}s limit`,
            durationMs: Date.now() - start
          });
        }
      }, timeoutMs);

      if (options.input !== undefined && child.stdin) {
        child.stdin.write(options.input);
        child.stdin.end();
      }

      child.stdout?.on('data', (d) => { stdout += d.toString(); });
      child.stderr?.on('data', (d) => { stderr += d.toString(); });

      child.on('error', (err) => {
        if (!isSettled) {
          isSettled = true;
          clearTimeout(timer);
          resolve({
            success: false,
            output: stdout,
            error: err.message,
            durationMs: Date.now() - start
          });
        }
      });

      child.on('close', (code) => {
        if (!isSettled) {
          isSettled = true;
          clearTimeout(timer);
          const cleanOutput = stdout.trim();
          const cleanError = stderr.trim();

          if (code === 0 && cleanOutput.length > 0) {
            resolve({
              success: true,
              output: cleanOutput,
              durationMs: Date.now() - start
            });
          } else {
            resolve({
              success: false,
              output: cleanOutput,
              error: cleanError || (cleanOutput ? `Code ${code}: ${cleanOutput}` : `Exited with code ${code}`),
              durationMs: Date.now() - start
            });
          }
        }
      });
    });
  }

  public isAvailable(): { available: boolean; version: string | null } {
    const isWin = process.platform === 'win32';
    const file = isWin ? 'cmd.exe' : this.command;
    const args = isWin ? ['/d', '/s', '/c', this.command, '--version'] : ['--version'];

    try {
      const res = cp.spawnSync(file, args, {
        encoding: 'utf8',
        timeout: 3000
      });

      if (res.status === 0 || (res.stdout && res.stdout.trim())) {
        const ver = (res.stdout || '').trim().split(/\r?\n/)[0] || 'installed';
        return { available: true, version: ver };
      }
    } catch {}

    return { available: false, version: null };
  }

  abstract execute(prompt: string, timeoutMs?: number, cwd?: string): Promise<AdapterExecutionResult>;
}
