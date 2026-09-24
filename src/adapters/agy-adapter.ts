import { BaseAdapter, AdapterExecutionResult, ExecuteOptions, SignIn } from './base-adapter.js';
import { AgentId } from '../types.js';

export class AgyAdapter extends BaseAdapter {
  readonly id: AgentId = 'agy';
  readonly name = 'Google Antigravity (agy)';
  readonly command = 'agy';

  /** `agy models` lists models only when signed in. It sends no prompt and uses no quota. */
  protected override async checkSignIn(): Promise<SignIn> {
    const res = await this.runProcess(['models'], { timeoutMs: 30_000 });
    if (res.success && /gemini|claude|gpt/i.test(res.output)) return { state: 'in' };
    if (/sign ?in|log ?in|auth|credential|unauthori[sz]ed|401/i.test(`${res.output}\n${res.error ?? ''}`)) {
      return { state: 'out', detail: 'Not signed in. Open PowerShell, type agy, and sign in with your Google account.' };
    }
    return { state: 'unknown' };
  }

  async execute(prompt: string, opts: ExecuteOptions = {}): Promise<AdapterExecutionResult> {
    const mode = opts.permission === 'readonly' ? 'plan' : 'accept-edits';
    // agy doesn't treat the working directory as editable on its own: without --add-dir it
    // writes into its private scratch folder instead of the project.
    const workspace = opts.cwd ? ['--add-dir', opts.cwd] : [];
    // agy parses Go-style flags: all flags must come before the prompt.
    return this.runProcess(['--mode', mode, ...workspace, ...(opts.model ? ['--model', opts.model] : []), '-p', prompt], opts);
  }
}
