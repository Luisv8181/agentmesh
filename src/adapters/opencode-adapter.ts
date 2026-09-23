import { BaseAdapter, AdapterExecutionResult } from './base-adapter.js';
import { AgentId } from '../types.js';

export class OpenCodeAdapter extends BaseAdapter {
  readonly id: AgentId = 'opencode';
  readonly name = 'OpenCode AI CLI';
  readonly command = 'opencode';

  async execute(prompt: string, timeoutMs = 180_000, cwd?: string): Promise<AdapterExecutionResult> {
    return this.runProcess(['run', prompt], { timeoutMs, cwd });
  }
}
