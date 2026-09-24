import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BaseAdapter, AdapterExecutionResult, ExecuteOptions, SignIn } from './base-adapter.js';
import { AgentId } from '../types.js';

export class GeminiAdapter extends BaseAdapter {
  readonly id: AgentId = 'gemini';
  readonly name = 'Google Gemini';
  readonly command = 'gemini';

  constructor(private geminiHome = path.join(os.homedir(), '.gemini')) {
    super();
  }

  /**
   * Gemini CLI has no status command, so read which sign-in type it's set to and whether an API key
   * exists (never the key itself). A personal Google-account sign-in is flagged: free accounts are rejected.
   */
  protected override async checkSignIn(): Promise<SignIn> {
    let type: string | undefined;
    try {
      const s = JSON.parse(fs.readFileSync(path.join(this.geminiHome, 'settings.json'), 'utf8')) as {
        security?: { auth?: { selectedType?: string } };
        selectedAuthType?: string;
      };
      type = s.security?.auth?.selectedType ?? s.selectedAuthType;
    } catch {
      // No settings yet: never signed in.
    }
    const hasKey =
      !!process.env.GEMINI_API_KEY ||
      (() => {
        try {
          return /^\s*GEMINI_API_KEY\s*=\s*\S/m.test(fs.readFileSync(path.join(this.geminiHome, '.env'), 'utf8'));
        } catch {
          return false;
        }
      })();

    if (type === 'gemini-api-key') {
      return hasKey ? { state: 'in' } : { state: 'out', detail: 'Set to use an API key, but no key was found. Type gemini and enter your free key from aistudio.google.com/apikey.' };
    }
    if (type === 'oauth-personal') return { state: 'in', authType: 'google-account' };
    if (type) return { state: 'in' };
    return { state: 'out', detail: 'Not set up yet. Get a free key at aistudio.google.com/apikey, then type gemini and choose the API key option.' };
  }

  async execute(prompt: string, opts: ExecuteOptions = {}): Promise<AdapterExecutionResult> {
    const mode = opts.permission === 'readonly' ? 'plan' : 'auto_edit';
    return this.runProcess(['--skip-trust', '--approval-mode', mode, ...(opts.model ? ['-m', opts.model] : []), '-p', prompt], opts);
  }
}
