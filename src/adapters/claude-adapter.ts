import { BaseAdapter, AdapterExecutionResult, ExecuteOptions } from './base-adapter.js';
import { AgentId } from '../types.js';

export class ClaudeAdapter extends BaseAdapter {
  readonly id: AgentId = 'claude';
  readonly name = 'Claude Code';
  readonly command = 'claude';

  async execute(prompt: string, opts: ExecuteOptions = {}): Promise<AdapterExecutionResult> {
    // acceptEdits: may edit files, but shell commands are still denied in headless mode.
    const mode = opts.permission === 'readonly' ? 'plan' : 'acceptEdits';
    return this.runProcess(['-p', '--permission-mode', mode, ...(opts.model ? ['--model', opts.model] : [])], { ...opts, input: prompt });
  }
}
