import { BaseAdapter, AdapterExecutionResult, ExecuteOptions, SignIn } from './base-adapter.js';
import { AgentId } from '../types.js';

export class CodexAdapter extends BaseAdapter {
  readonly id: AgentId = 'codex';
  readonly name = 'OpenAI Codex';
  readonly command = 'codex';

  /** `codex login status` prints "Logged in using …" or "Not logged in". */
  protected override async checkSignIn(): Promise<SignIn> {
    const res = await this.runProcess(['login', 'status'], { timeoutMs: 20_000 });
    const text = `${res.output}\n${res.error ?? ''}`;
    if (/not logged in/i.test(text)) return { state: 'out', detail: 'Not signed in. Open PowerShell, type codex login, and sign in with ChatGPT.' };
    if (/logged in/i.test(text)) return { state: 'in' };
    return { state: 'unknown' };
  }

  async execute(prompt: string, opts: ExecuteOptions = {}): Promise<AdapterExecutionResult> {
    const sandbox = opts.permission === 'readonly' ? 'read-only' : 'workspace-write';
    return this.runProcess(['exec', '--skip-git-repo-check', '-s', sandbox, ...(opts.model ? ['-m', opts.model] : []), '-'], { ...opts, input: prompt });
  }
}
