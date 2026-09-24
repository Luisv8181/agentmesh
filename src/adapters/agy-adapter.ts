import { BaseAdapter, AdapterExecutionResult, ExecuteOptions } from './base-adapter.js';
import { AgentId } from '../types.js';

export class AgyAdapter extends BaseAdapter {
  readonly id: AgentId = 'agy';
  readonly name = 'Google Antigravity (agy)';
  readonly command = 'agy';

  async execute(prompt: string, opts: ExecuteOptions = {}): Promise<AdapterExecutionResult> {
    const mode = opts.permission === 'readonly' ? 'plan' : 'accept-edits';
    // agy doesn't treat the working directory as editable on its own: without --add-dir it
    // writes into its private scratch folder instead of the project.
    const workspace = opts.cwd ? ['--add-dir', opts.cwd] : [];
    // agy parses Go-style flags: all flags must come before the prompt.
    return this.runProcess(['--mode', mode, ...workspace, '-p', prompt], opts);
  }
}
