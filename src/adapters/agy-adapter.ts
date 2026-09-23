import * as cp from 'child_process';
import { BaseAdapter, AdapterExecutionResult } from './base-adapter.js';
import { AgentId } from '../types.js';

export class AgyAdapter extends BaseAdapter {
  readonly id: AgentId = 'agy';
  readonly name = 'Google Antigravity CLI (agy)';
  readonly command = 'agy';

  private resolveBinary(): string {
    const isWin = process.platform === 'win32';
    // Check if 'agy' or 'antigravity' exists on PATH
    for (const bin of ['agy', 'antigravity']) {
      try {
        const file = isWin ? 'cmd.exe' : bin;
        const args = isWin ? ['/d', '/s', '/c', bin, '--version'] : ['--version'];
        const res = cp.spawnSync(file, args, { encoding: 'utf8', timeout: 2000 });
        if (res.status === 0 || (res.stdout && res.stdout.trim())) {
          return bin;
        }
      } catch {}
    }
    return 'agy';
  }

  override isAvailable(): { available: boolean; version: string | null } {
    const isWin = process.platform === 'win32';
    for (const bin of ['agy', 'antigravity']) {
      const file = isWin ? 'cmd.exe' : bin;
      const args = isWin ? ['/d', '/s', '/c', bin, '--version'] : ['--version'];
      try {
        const res = cp.spawnSync(file, args, { encoding: 'utf8', timeout: 3000 });
        if (res.status === 0 || (res.stdout && res.stdout.trim())) {
          const ver = (res.stdout || '').trim().split(/\r?\n/)[0] || 'installed';
          return { available: true, version: ver };
        }
      } catch {}
    }
    return { available: false, version: null };
  }

  async execute(prompt: string, timeoutMs = 180_000, cwd?: string): Promise<AdapterExecutionResult> {
    const bin = this.resolveBinary();
    // agy supports non-interactive execution with prompt input
    return this.runProcess(['--non-interactive', '-p', prompt], { timeoutMs, cwd });
  }
}
