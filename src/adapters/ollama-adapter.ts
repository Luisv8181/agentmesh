import { BaseAdapter, AdapterExecutionResult, Availability, ExecuteOptions, DEFAULT_TIMEOUT_MS } from './base-adapter.js';
import { AgentId } from '../types.js';
import { buildProjectContext } from '../workspace/project-context.js';

export class OllamaAdapter extends BaseAdapter {
  readonly id: AgentId = 'ollama';
  readonly name = 'Ollama (local, free)';
  readonly command = 'ollama';
  private baseUrl: string;
  public model: string;

  get endpoint(): string {
    return this.baseUrl;
  }

  constructor(baseUrl = 'http://127.0.0.1:11434', model = 'qwen2.5:7b') {
    super();
    this.baseUrl = process.env.OLLAMA_BASE_URL || baseUrl;
    this.model = model;
  }

  /** Available means the Ollama app is running and the configured model is downloaded. */
  protected override async probe(): Promise<Availability> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(3_000) });
      if (!res.ok) return { available: false, version: null, detail: `Ollama responded with HTTP ${res.status}` };
      const data = (await res.json()) as { models?: { name: string }[] };
      const names = (data.models || []).map((m) => m.name);
      const wanted = this.model.includes(':') ? this.model : `${this.model}:latest`;
      if (!names.includes(wanted)) {
        return { available: false, version: null, detail: `Model "${this.model}" not downloaded. Run: ollama pull ${this.model}` };
      }
      return { available: true, version: this.model };
    } catch {
      return { available: false, version: null, detail: 'Ollama is not running (install it or open the Ollama app)' };
    }
  }

  async execute(prompt: string, opts: ExecuteOptions = {}): Promise<AdapterExecutionResult> {
    const start = Date.now();
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    let output = '';

    // Ollama is chat-only: it can't open files, so it gets a read-only snapshot and is told it can't edit.
    const messages = opts.cwd
      ? [
          {
            role: 'system',
            content:
              'You are helping with the project below. You can read it but you cannot change files. ' +
              'When changes are needed, show the exact new code and say which file it goes in.\n\n' +
              buildProjectContext(opts.cwd)
          },
          { role: 'user', content: prompt }
        ]
      : [{ role: 'user', content: prompt }];

    try {
      const res = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, messages, stream: true, options: { num_ctx: 16_384 } }),
        signal
      });

      if (!res.ok || !res.body) {
        return { success: false, output: '', error: `Ollama HTTP ${res.status}: ${await res.text()}`, durationMs: Date.now() - start };
      }

      const decoder = new TextDecoder();
      let buffered = '';
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buffered += decoder.decode(chunk, { stream: true });
        const lines = buffered.split('\n');
        buffered = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const piece = (JSON.parse(line) as { message?: { content?: string } }).message?.content ?? '';
          if (piece) {
            output += piece;
            opts.onOutput?.(piece);
          }
        }
      }

      return output.trim()
        ? { success: true, output: output.trim(), durationMs: Date.now() - start }
        : { success: false, output: '', error: 'Ollama returned an empty response', durationMs: Date.now() - start };
    } catch (err) {
      const cancelled = opts.signal?.aborted === true;
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        output: output.trim(),
        error: cancelled ? 'Stopped by user' : `Ollama error: ${message}`,
        cancelled,
        durationMs: Date.now() - start
      };
    }
  }
}
