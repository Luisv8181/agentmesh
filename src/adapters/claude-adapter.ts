import { BaseAdapter, AdapterExecutionResult } from './base-adapter.js';
import { AgentId } from '../types.js';

export class ClaudeAdapter extends BaseAdapter {
  readonly id: AgentId = 'claude';
  readonly name = 'Claude Code CLI';
  readonly command = 'claude';

  async execute(prompt: string, timeoutMs = 180_000, cwd?: string): Promise<AdapterExecutionResult> {
    return this.runProcess(['-p', prompt], { timeoutMs, cwd });
  }
}
