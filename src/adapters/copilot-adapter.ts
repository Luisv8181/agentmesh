import { BaseAdapter, AdapterExecutionResult, ExecuteOptions, SignIn } from './base-adapter.js';
import { AgentId } from '../types.js';

/**
 * GitHub Copilot CLI (`npm install -g @github/copilot`). Included in every Copilot plan, Free too,
 * with a limited monthly allowance. Flags per GitHub's programmatic reference:
 * -p runs one prompt and exits, -s prints only the answer, --no-ask-user never waits for input,
 * --allow-tool write lets it edit files but not run shell commands.
 */
export class CopilotAdapter extends BaseAdapter {
  readonly id: AgentId = 'copilot';
  readonly name = 'GitHub Copilot';
  readonly command = 'copilot';

  /**
   * There's no documented status command. Tokens in the environment mean signed in; otherwise the
   * login may live in the system keyring, so report "unknown" (don't block) and let a failed run say so.
   */
  protected override async checkSignIn(): Promise<SignIn> {
    if (process.env.COPILOT_GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN) return { state: 'in' };
    return { state: 'unknown' };
  }

  async execute(prompt: string, opts: ExecuteOptions = {}): Promise<AdapterExecutionResult> {
    return this.runProcess(
      [
        '-p', prompt,
        '-s',
        '--no-ask-user',
        ...(opts.model ? ['--model', opts.model] : []),
        // Variadic option: keep it last so it can't swallow other arguments.
        ...(opts.permission === 'readonly' ? [] : ['--allow-tool', 'write'])
      ],
      opts
    );
  }
}
