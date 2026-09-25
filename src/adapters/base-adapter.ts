import * as cp from 'child_process';
import { AgentId } from '../types.js';
import { resolveCommand } from './resolve-command.js';

export interface AdapterExecutionResult {
  success: boolean;
  output: string;
  error?: string;
  cancelled?: boolean;
  durationMs: number;
}

export interface ExecuteOptions {
  timeoutMs?: number;
  cwd?: string;
  /** 'edit' lets the agent change files; 'readonly' asks it to only read and answer. */
  permission?: 'edit' | 'readonly';
  /** Model override for this run; omitted means the CLI's own default. */
  model?: string;
  onOutput?: (chunk: string) => void;
  signal?: AbortSignal;
}

export interface Availability {
  available: boolean;
  version: string | null;
  /** Human-readable reason when not available (e.g. "model not downloaded"). */
  detail?: string;
  /** See SignIn.authType. */
  authType?: string;
}

export interface SignIn {
  state: 'in' | 'out' | 'unknown';
  /** What to do, in plain language, when signed out. */
  detail?: string;
  /** 'google-account' for Gemini CLI signed in with a personal Google account (free accounts are rejected). */
  authType?: string;
}

export const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const AVAILABILITY_TTL_MS = 60_000;
/** Sign-in checks spawn a CLI (and agy makes a network call), so they refresh less often than --version. */
const SIGN_IN_TTL_MS = 10 * 60_000;

/**
 * Shared across adapter instances: whether a CLI is installed and signed in doesn't depend on which
 * project is open, so switching projects shouldn't re-run every check (it took several seconds).
 */
const availabilityCaches = new Map<string, { value: Availability; at: number }>();
const signInCaches = new Map<string, { value: SignIn; at: number }>();

export abstract class BaseAdapter {
  abstract readonly id: AgentId;
  abstract readonly name: string;
  abstract readonly command: string;

  private get cacheKey(): string {
    return `${this.constructor.name}:${this.command}`;
  }
  private get availabilityCache() {
    return availabilityCaches.get(this.cacheKey) ?? null;
  }
  private set availabilityCache(v: { value: Availability; at: number } | null) {
    if (v) availabilityCaches.set(this.cacheKey, v);
    else availabilityCaches.delete(this.cacheKey);
  }
  private get signInCache() {
    return signInCaches.get(this.cacheKey) ?? null;
  }
  private set signInCache(v: { value: SignIn; at: number } | null) {
    if (v) signInCaches.set(this.cacheKey, v);
    else signInCaches.delete(this.cacheKey);
  }

  abstract execute(prompt: string, options?: ExecuteOptions): Promise<AdapterExecutionResult>;

  /**
   * Installed AND signed in. Uses each CLI's own local status command (no prompt is sent, nothing is
   * charged), so "Ready" means the agent will actually work rather than fail at its first run.
   */
  public async isAvailable(force = false): Promise<Availability> {
    if (!force && this.availabilityCache && Date.now() - this.availabilityCache.at < AVAILABILITY_TTL_MS) {
      return this.availabilityCache.value;
    }
    let value = await this.probe();
    if (value.available) {
      const signIn = await this.signInStatus(force);
      if (signIn.state === 'out') value = { available: false, version: value.version, detail: signIn.detail ?? 'Not signed in' };
      else if (signIn.authType) value = { ...value, authType: signIn.authType };
    }
    this.availabilityCache = { value, at: Date.now() };
    return value;
  }

  public async signInStatus(force = false): Promise<SignIn> {
    if (!force && this.signInCache && Date.now() - this.signInCache.at < SIGN_IN_TTL_MS) return this.signInCache.value;
    let value: SignIn;
    try {
      value = await this.checkSignIn();
    } catch {
      value = { state: 'unknown' };
    }
    this.signInCache = { value, at: Date.now() };
    return value;
  }

  /** Override per CLI. Default: no way to tell, so don't block. */
  protected async checkSignIn(): Promise<SignIn> {
    return { state: 'unknown' };
  }

  protected async probe(): Promise<Availability> {
    if (!resolveCommand(this.command)) {
      return { available: false, version: null, detail: 'Not installed' };
    }
    const res = await this.runProcess(['--version'], { timeoutMs: 8_000 });
    const firstLine = (res.output || res.error || '').split(/\r?\n/)[0].trim();
    if (res.success || firstLine) {
      return { available: true, version: firstLine || 'installed' };
    }
    return { available: false, version: null, detail: 'Installed but not responding' };
  }

  public runProcess(
    args: string[],
    options: { timeoutMs?: number; input?: string; cwd?: string; onOutput?: (chunk: string) => void; signal?: AbortSignal } = {}
  ): Promise<AdapterExecutionResult> {
    const start = Date.now();
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const resolved = resolveCommand(this.command);

    if (!resolved) {
      return Promise.resolve({
        success: false,
        output: '',
        error: `${this.name} is not installed (could not find "${this.command}" on PATH)`,
        durationMs: 0
      });
    }

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let settled = false;

      // No shell: arguments reach the CLI exactly as given, newlines and `&` included.
      const child = cp.spawn(resolved.file, [...resolved.prefixArgs, ...args], {
        cwd: options.cwd || process.cwd(),
        stdio: [options.input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' }
      });

      const finish = (result: Omit<AdapterExecutionResult, 'durationMs'>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        resolve({ ...result, durationMs: Date.now() - start });
      };

      const timer = setTimeout(() => {
        killTree(child);
        finish({ success: false, output: stdout.trim(), error: `Timeout: ${this.name} took longer than ${Math.round(timeoutMs / 60_000)} min` });
      }, timeoutMs);

      const onAbort = () => {
        killTree(child);
        finish({ success: false, output: stdout.trim(), error: 'Stopped by user', cancelled: true });
      };
      if (options.signal?.aborted) onAbort();
      options.signal?.addEventListener('abort', onAbort);

      if (options.input !== undefined && child.stdin) {
        child.stdin.on('error', () => {});
        child.stdin.end(options.input);
      }

      child.stdout?.on('data', (d) => {
        const text = d.toString();
        stdout += text;
        options.onOutput?.(text);
      });
      child.stderr?.on('data', (d) => { stderr += d.toString(); });

      child.on('error', (err) => finish({ success: false, output: stdout, error: err.message }));

      child.on('close', (code) => {
        const out = stdout.trim();
        const err = stderr.trim();
        if (code === 0 && out.length > 0) {
          finish({ success: true, output: out });
        } else {
          finish({ success: false, output: out, error: err || (out ? `Exited with code ${code}: ${out}` : `Exited with code ${code}`) });
        }
      });
    });
  }
}

function killTree(child: cp.ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    // Node CLIs spawn their own children; kill the whole tree or they keep running.
    cp.spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } else {
    try { child.kill('SIGKILL'); } catch {}
  }
}
