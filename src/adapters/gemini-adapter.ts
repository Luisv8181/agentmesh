import { BaseAdapter, AdapterExecutionResult, ExecuteOptions } from './base-adapter.js';
import { AgentId } from '../types.js';

export class GeminiAdapter extends BaseAdapter {
  readonly id: AgentId = 'gemini';
  readonly name = 'Google Gemini';
  readonly command = 'gemini';

  async execute(prompt: string, opts: ExecuteOptions = {}): Promise<AdapterExecutionResult> {
    const mode = opts.permission === 'readonly' ? 'plan' : 'auto_edit';
    return this.runProcess(['--skip-trust', '--approval-mode', mode, '-p', prompt], opts);
  }
}
