import { BaseAdapter, AdapterExecutionResult, ExecuteOptions, SignIn } from './base-adapter.js';
import { AgentId } from '../types.js';

export class ClaudeAdapter extends BaseAdapter {
  readonly id: AgentId = 'claude';
  readonly name = 'Claude Code';
  readonly command = 'claude';

  /** `claude auth status` prints JSON with loggedIn; local, no prompt sent. */
  protected override async checkSignIn(): Promise<SignIn> {
    const res = await this.runProcess(['auth', 'status'], { timeoutMs: 20_000 });
    const m = (res.output || res.error || '').match(/"loggedIn"\s*:\s*(true|false)/);
    if (!m) return { state: 'unknown' };
    return m[1] === 'true' ? { state: 'in' } : { state: 'out', detail: 'Not signed in. Open PowerShell, type claude auth login, and sign in (signing in to the Claude app isn’t enough).' };
  }

  async execute(prompt: string, opts: ExecuteOptions = {}): Promise<AdapterExecutionResult> {
    // acceptEdits: may edit files, but shell commands are still denied in headless mode.
    const mode = opts.permission === 'readonly' ? 'plan' : 'acceptEdits';
    return this.runProcess(['-p', '--permission-mode', mode, ...(opts.model ? ['--model', opts.model] : [])], { ...opts, input: prompt });
  }
}
