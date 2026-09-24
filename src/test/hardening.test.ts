import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import * as cp from 'child_process';
import { ClaudeAdapter } from '../adapters/claude-adapter.js';
import { GeminiAdapter } from '../adapters/gemini-adapter.js';
import { AgyAdapter } from '../adapters/agy-adapter.js';
import { BaseAdapter, AdapterExecutionResult, Availability, ExecuteOptions } from '../adapters/base-adapter.js';
import { clearResolveCache } from '../adapters/resolve-command.js';
import { AgentSelector } from '../router/agent-selector.js';
import { TaskStore } from '../state/task-store.js';
import { ConfigStore } from '../state/config-store.js';
import { startUiServer } from '../ui/server.js';
import { AgentId } from '../types.js';

process.env.AGENTMESH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmesh-home-'));

const NASTY_PROMPT = '[TOKEN BUDGET & CONTEXT]\nline two | echo pwned > x.txt\n"quoted" %PATH% ^caret\nlast line';

/**
 * Installs a fake CLI the same way npm does on this OS (a .cmd shim + JS file on Windows,
 * an executable script elsewhere). The fake prints the argv and stdin it received as JSON.
 */
function installFakeCli(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `agentmesh-fake-${name}-`));
  const js = `let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({args:process.argv.slice(2),stdin:input}))});`;
  if (process.platform === 'win32') {
    const pkgDir = path.join(dir, 'node_modules', `fake-${name}`);
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'cli.js'), js);
    fs.writeFileSync(
      path.join(dir, `${name}.cmd`),
      `@ECHO off\r\nSETLOCAL\r\nSET dp0=%~dp0\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n)\r\nendLocal & "%_prog%"  "%dp0%\\node_modules\\fake-${name}\\cli.js" %*\r\n`
    );
  } else {
    const file = path.join(dir, name);
    fs.writeFileSync(file, `#!/usr/bin/env node\n${js}`);
    fs.chmodSync(file, 0o755);
  }
  process.env.PATH = `${dir}${path.delimiter}${process.env.PATH}`;
  clearResolveCache();
  return dir;
}

test('Claude adapter delivers the full prompt intact (stdin) with edit permission', async () => {
  installFakeCli('claude');
  const res = await new ClaudeAdapter().execute(NASTY_PROMPT, { timeoutMs: 20_000 });
  assert.strictEqual(res.success, true, res.error);
  const got = JSON.parse(res.output);
  assert.strictEqual(got.stdin, NASTY_PROMPT);
  assert.deepStrictEqual(got.args, ['-p', '--permission-mode', 'acceptEdits']);
});

test('Gemini adapter passes a prompt with shell metacharacters and newlines as one exact argument', async () => {
  installFakeCli('gemini');
  const res = await new GeminiAdapter().execute(NASTY_PROMPT, { timeoutMs: 20_000 });
  assert.strictEqual(res.success, true, res.error);
  const got = JSON.parse(res.output);
  assert.strictEqual(got.args[got.args.length - 1], NASTY_PROMPT);
  assert.ok(got.args.includes('auto_edit'));
});

test('agy adapter uses flags agy actually supports, prompt last', async () => {
  installFakeCli('agy');
  const res = await new AgyAdapter().execute(NASTY_PROMPT, { timeoutMs: 20_000, permission: 'readonly' });
  assert.strictEqual(res.success, true, res.error);
  const got = JSON.parse(res.output);
  assert.deepStrictEqual(got.args, ['--mode', 'plan', '-p', NASTY_PROMPT]);
});

class ScriptedAdapter extends BaseAdapter {
  readonly id: AgentId;
  readonly name: string;
  readonly command: string;
  calls = 0;
  constructor(id: AgentId, private behavior: (prompt: string, opts: ExecuteOptions) => Promise<AdapterExecutionResult>) {
    super();
    this.id = id;
    this.name = `Scripted ${id}`;
    this.command = id;
  }
  override async isAvailable(): Promise<Availability> {
    return { available: true, version: 'test' };
  }
  async execute(prompt: string, opts: ExecuteOptions = {}): Promise<AdapterExecutionResult> {
    this.calls++;
    return this.behavior(prompt, opts);
  }
}

const rateLimited = async (): Promise<AdapterExecutionResult> => ({ success: false, output: '', error: '429 rate limit', durationMs: 1 });
const ok = async (): Promise<AdapterExecutionResult> => ({ success: true, output: 'done', durationMs: 1 });

function gitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmesh-git-'));
  const git = (...args: string[]) => cp.spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  fs.writeFileSync(path.join(dir, 'tracked.txt'), 'v1');
  git('add', '.');
  git('commit', '-qm', 'init');
  return dir;
}

function commitCount(dir: string): number {
  return Number(cp.spawnSync('git', ['rev-list', '--count', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout.trim());
}

/** Fresh user-level state per test: config and rate-limit cooldowns must not leak between tests. */
function freshConfig(patch: Partial<ReturnType<ConfigStore['get']>> = {}): ConfigStore {
  process.env.AGENTMESH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmesh-home-'));
  const store = new ConfigStore();
  store.update(patch);
  return store;
}

test('Handoff does not commit anything unless autoCommit is turned on', async () => {
  const dir = gitRepo();
  fs.writeFileSync(path.join(dir, 'tracked.txt'), 'v2');
  fs.writeFileSync(path.join(dir, '.env'), 'SECRET=1');

  const selector = new AgentSelector(dir, false, freshConfig({ priority: ['claude', 'codex'] }));
  selector.register(new ScriptedAdapter('claude', rateLimited));
  selector.register(new ScriptedAdapter('codex', ok));
  const task = new TaskStore(dir).createTask('t', ['r']);

  const res = await selector.executeTask(task, 'go');
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.agent, 'codex');
  assert.strictEqual(commitCount(dir), 1, 'no checkpoint commit by default');
});

test('With autoCommit on, the checkpoint commits tracked changes but never untracked files like .env', async () => {
  const dir = gitRepo();
  fs.writeFileSync(path.join(dir, 'tracked.txt'), 'v2');
  fs.writeFileSync(path.join(dir, '.env'), 'SECRET=1');

  const selector = new AgentSelector(dir, false, freshConfig({ priority: ['claude', 'codex'], autoCommit: true }));
  selector.register(new ScriptedAdapter('claude', rateLimited));
  selector.register(new ScriptedAdapter('codex', ok));
  await selector.executeTask(new TaskStore(dir).createTask('t', ['r']), 'go');

  assert.strictEqual(commitCount(dir), 2);
  const files = cp.spawnSync('git', ['show', '--name-only', '--format=', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout.trim().split(/\r?\n/);
  assert.deepStrictEqual(files, ['tracked.txt']);
});

test('Safe Mode never calls OpenCode (it can bill API credits)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmesh-safe-oc-'));
  const selector = new AgentSelector(dir, true, freshConfig({ priority: ['opencode', 'ollama'] }));
  const opencode = new ScriptedAdapter('opencode', ok);
  const ollama = new ScriptedAdapter('ollama', ok);
  selector.register(opencode);
  selector.register(ollama);

  const res = await selector.executeTask(new TaskStore(dir).createTask('t', ['r']), 'go');
  assert.strictEqual(res.agent, 'ollama');
  assert.strictEqual(opencode.calls, 0);
});

test('Stopping a run does not fail over to the next agent', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmesh-cancel-'));
  const selector = new AgentSelector(dir, false, freshConfig({ priority: ['claude', 'codex'] }));
  const slow = new ScriptedAdapter('claude', (_p, opts) =>
    new Promise((resolve) => {
      opts.signal?.addEventListener('abort', () => resolve({ success: false, output: 'partial', error: 'Stopped by user', cancelled: true, durationMs: 1 }));
    })
  );
  const codex = new ScriptedAdapter('codex', ok);
  selector.register(slow);
  selector.register(codex);

  const abort = new AbortController();
  const pending = selector.executeTask(new TaskStore(dir).createTask('t', ['r']), 'go', undefined, { signal: abort.signal });
  setTimeout(() => abort.abort(), 50);
  const res = await pending;

  assert.strictEqual(res.cancelled, true);
  assert.strictEqual(codex.calls, 0);
});

test('Runs are recorded on the task with the files the agent changed, and fed to the next run', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmesh-runs-'));
  const selector = new AgentSelector(dir, false, freshConfig({ priority: ['claude'] }));
  const prompts: string[] = [];
  selector.register(
    new ScriptedAdapter('claude', async (prompt) => {
      prompts.push(prompt);
      fs.writeFileSync(path.join(dir, `file${prompts.length}.txt`), 'x');
      return { success: true, output: `made file${prompts.length}`, durationMs: 1 };
    })
  );
  const store = new TaskStore(dir);
  const task = store.createTask('t', ['r']);

  await selector.executeTask(task, 'first step');
  await selector.executeTask(task, 'second step');

  const saved = store.getTask(task.taskId)!;
  assert.strictEqual(saved.runs?.length, 2);
  assert.deepStrictEqual(saved.runs![0].filesChanged, ['file1.txt']);
  assert.ok(prompts[1].includes('first step') && prompts[1].includes('file1.txt'), 'second prompt includes earlier step');
});

test('When no agent can run, the error explains why in plain language', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmesh-none-'));
  const selector = new AgentSelector(dir, false, freshConfig({ priority: ['claude'] }));
  const missing = new ScriptedAdapter('claude', ok);
  missing.isAvailable = async () => ({ available: false, version: null, detail: 'Not installed' });
  selector.register(missing);

  const res = await selector.executeTask(new TaskStore(dir).createTask('t', ['r']), 'go');
  assert.strictEqual(res.success, false);
  assert.match(res.error ?? '', /Scripted claude: Not installed/);
});

function rawRequest(port: number, opts: { method?: string; path: string; headers?: Record<string, string>; body?: string }) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: opts.method ?? 'GET', path: opts.path, headers: opts.headers }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end(opts.body);
  });
}

test('Dashboard API rejects requests a hostile web page could send', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmesh-sec-'));
  const port = 3471;
  const ui = await startUiServer(port, dir, true);
  const host = `127.0.0.1:${port}`;
  const body = JSON.stringify({ safeMode: false });

  try {
    // No token (what a cross-site form post or no-cors fetch looks like)
    let r = await rawRequest(port, { method: 'POST', path: '/api/mode', headers: { Host: host, 'Content-Type': 'text/plain' }, body });
    assert.strictEqual(r.status, 401);

    // Right token but foreign Origin
    r = await rawRequest(port, {
      method: 'POST', path: '/api/mode', body,
      headers: { Host: host, Origin: 'https://evil.example', 'Content-Type': 'application/json', 'x-agentmesh-token': ui.token }
    });
    assert.strictEqual(r.status, 403);

    // DNS rebinding: attacker's hostname in Host header, even for the page itself
    r = await rawRequest(port, { path: '/', headers: { Host: `evil.example:${port}` } });
    assert.strictEqual(r.status, 403);
    assert.ok(!r.body.includes(ui.token));

    // Right token but non-JSON body type
    r = await rawRequest(port, {
      method: 'POST', path: '/api/mode', body,
      headers: { Host: host, 'Content-Type': 'text/plain', 'x-agentmesh-token': ui.token }
    });
    assert.strictEqual(r.status, 415);

    // Still in Safe Mode after all of the above
    r = await rawRequest(port, { path: '/api/state', headers: { Host: host, 'x-agentmesh-token': ui.token } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(JSON.parse(r.body).safeMode, true);

    // No CORS grant, and the page refuses to be framed
    const page = await fetch(`http://${host}/`);
    assert.strictEqual(page.headers.get('access-control-allow-origin'), null);
    assert.match(page.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
  } finally {
    await ui.close();
  }
});

test('Ollama project snapshot includes project files but never secrets', async () => {
  const { buildProjectContext } = await import('../workspace/project-context.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmesh-ctx-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>My bakery</h1>');
  fs.writeFileSync(path.join(dir, '.env'), 'API_KEY=super-secret-value');
  fs.writeFileSync(path.join(dir, 'server.key'), 'PRIVATE KEY MATERIAL');
  fs.writeFileSync(path.join(dir, 'credentials.json'), '{"token":"cred-token-123"}');
  fs.mkdirSync(path.join(dir, 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'x', 'index.js'), 'vendored');

  const ctx = buildProjectContext(dir);
  assert.ok(ctx.includes('<h1>My bakery</h1>'));
  assert.ok(!ctx.includes('super-secret-value'));
  assert.ok(!ctx.includes('PRIVATE KEY MATERIAL'));
  assert.ok(!ctx.includes('cred-token-123'));
  assert.ok(!ctx.includes('vendored'));
});

test('Opening a folder in AgentMesh leaves no files behind until a task is saved', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmesh-notrace-'));
  const selector = new AgentSelector(dir, false, freshConfig());
  await selector.getStatuses();
  new TaskStore(dir).listTasks();
  assert.deepStrictEqual(fs.readdirSync(dir), []);
});
