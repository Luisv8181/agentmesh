import { BaseAdapter, AdapterExecutionResult } from './base-adapter.js';
import { AgentId } from '../types.js';

export class OllamaAdapter extends BaseAdapter {
  readonly id: AgentId = 'ollama';
  readonly name = 'Local Ollama Fallback';
  readonly command = 'ollama';
  private baseUrl: string;
  private defaultModel: string;

  constructor(baseUrl = 'http://127.0.0.1:11434', defaultModel = 'qwen2.5:7b') {
    super();
    this.baseUrl = process.env.OLLAMA_BASE_URL || baseUrl;
    this.defaultModel = process.env.OLLAMA_MODEL || defaultModel;
  }

  async execute(prompt: string, timeoutMs = 180_000): Promise<AdapterExecutionResult> {
    const start = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.defaultModel,
          messages: [{ role: 'user', content: prompt }],
          stream: false
        }),
        signal: controller.signal
      });

      clearTimeout(timeout);

      if (!res.ok) {
        const errorText = await res.text();
        return {
          success: false,
          output: '',
          error: `Ollama HTTP ${res.status}: ${errorText}`,
          durationMs: Date.now() - start
        };
      }

      const data = (await res.json()) as any;
      const content = data.message?.content || '';

      return {
        success: true,
        output: content,
        durationMs: Date.now() - start
      };
    } catch (err: any) {
      clearTimeout(timeout);
      return {
        success: false,
        output: '',
        error: `Ollama error: ${err.message || String(err)}`,
        durationMs: Date.now() - start
      };
    }
  }
}
