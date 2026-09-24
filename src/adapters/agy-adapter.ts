import { BaseAdapter, AdapterExecutionResult, ExecuteOptions } from './base-adapter.js';
import { AgentId } from '../types.js';

export class AgyAdapter extends BaseAdapter {
  readonly id: AgentId = 'agy';
  readonly name = 'Google Antigravity (agy)';
  readonly command = 'agy';

  async execute(prompt: string, opts: ExecuteOptions = {}): Promise<AdapterExecutionResult> {
    const mode = opts.permission === 'readonly' ? 'plan' : 'accept-edits';
    // agy parses Go-style flags: all flags must come before the prompt.
    return this.runProcess(['--mode', mode, '-p', prompt], opts);
  }
}
