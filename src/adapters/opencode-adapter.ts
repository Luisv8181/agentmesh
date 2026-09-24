import { BaseAdapter, AdapterExecutionResult, ExecuteOptions } from './base-adapter.js';
import { AgentId } from '../types.js';

export class OpenCodeAdapter extends BaseAdapter {
  readonly id: AgentId = 'opencode';
  readonly name = 'OpenCode';
  readonly command = 'opencode';

  async execute(prompt: string, opts: ExecuteOptions = {}): Promise<AdapterExecutionResult> {
    return this.runProcess(['run', prompt], opts);
  }
}
