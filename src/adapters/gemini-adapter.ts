import { BaseAdapter, AdapterExecutionResult } from './base-adapter.js';
import { AgentId } from '../types.js';

export class GeminiAdapter extends BaseAdapter {
  readonly id: AgentId = 'gemini';
  readonly name = 'Google Gemini CLI';
  readonly command = 'gemini';

  async execute(prompt: string, timeoutMs = 180_000, cwd?: string): Promise<AdapterExecutionResult> {
    return this.runProcess(['--skip-trust', '-p', prompt], { timeoutMs, cwd });
  }
}
