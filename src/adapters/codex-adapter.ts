import { BaseAdapter, AdapterExecutionResult, ExecuteOptions } from './base-adapter.js';
import { AgentId } from '../types.js';

export class CodexAdapter extends BaseAdapter {
  readonly id: AgentId = 'codex';
  readonly name = 'OpenAI Codex';
  readonly command = 'codex';

  async execute(prompt: string, opts: ExecuteOptions = {}): Promise<AdapterExecutionResult> {
    const sandbox = opts.permission === 'readonly' ? 'read-only' : 'workspace-write';
    return this.runProcess(['exec', '--skip-git-repo-check', '-s', sandbox, ...(opts.model ? ['-m', opts.model] : []), '-'], { ...opts, input: prompt });
  }
}
