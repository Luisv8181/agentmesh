import { BaseAdapter, AdapterExecutionResult } from './base-adapter.js';
import { AgentId } from '../types.js';

export class CodexAdapter extends BaseAdapter {
  readonly id: AgentId = 'codex';
  readonly name = 'OpenAI Codex CLI';
  readonly command = 'codex';

  async execute(prompt: string, timeoutMs = 180_000, cwd?: string): Promise<AdapterExecutionResult> {
    return this.runProcess(['exec', '--skip-git-repo-check', '-'], {
      timeoutMs,
      cwd,
      input: prompt
    });
  }
}
