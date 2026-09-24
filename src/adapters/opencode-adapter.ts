import { BaseAdapter, AdapterExecutionResult, ExecuteOptions, SignIn } from './base-adapter.js';
import { AgentId } from '../types.js';

export class OpenCodeAdapter extends BaseAdapter {
  readonly id: AgentId = 'opencode';
  readonly name = 'OpenCode';
  readonly command = 'opencode';

  /**
   * `opencode auth list` prints "N credentials" for providers you connected. Environment-variable
   * providers are listed too, but they aren't reliable (a GEMINI_API_KEY is shown yet runs still failed
   * asking for GOOGLE_GENERATIVE_AI_API_KEY), so only connected credentials count.
   */
  protected override async checkSignIn(): Promise<SignIn> {
    const res = await this.runProcess(['auth', 'list'], { timeoutMs: 20_000 });
    const text = `${res.output}\n${res.error ?? ''}`.replace(/\x1b\[[0-9;]*m/g, '');
    const m = text.match(/(\d+)\s+credentials?\b/i);
    if (!m) return { state: 'unknown' };
    return Number(m[1]) > 0
      ? { state: 'in' }
      : { state: 'out', detail: 'Not connected to an AI provider. Open PowerShell, type opencode, then /connect and choose OpenCode Zen (free models).' };
  }

  async execute(prompt: string, opts: ExecuteOptions = {}): Promise<AdapterExecutionResult> {
    return this.runProcess(['run', ...(opts.model ? ['-m', opts.model] : []), prompt], opts);
  }
}
