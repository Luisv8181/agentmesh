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
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmesh-agy-project-'));
  const res = await new AgyAdapter().execute(NASTY_PROMPT, { timeoutMs: 20_000, permission: 'readonly', cwd: project });
  assert.strictEqual(res.success, true, res.error);
  const got = JSON.parse(res.output);
  // --add-dir: without it agy writes into its own scratch folder instead of the project.
  assert.deepStrictEqual(got.args, ['--mode', 'plan', '--add-dir', project, '-p', NASTY_PROMPT]);
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

test('Real CLI failures are reduced to the line that matters, with a plain-language fix', async () => {
  const { keyErrorLine, fixHint } = await import('../router/error-hints.js');
  // Captured from real runs of each CLI on 2026-09-23.
  const claude = 'Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue.';
  const codex = [
    '2026-09-24T01:47:42.536610Z ERROR codex_models_manager::cache: failed to load models cache: missing field `base_instructions` at line 139 column 5',
    'OpenAI Codex v0.144.6', '--------', 'workdir: C:/relay-test', 'model: gpt-6-astra', 'provider: openai', '--------',
    'warning: Model metadata for `gpt-6-astra` not found. Defaulting to fallback metadata.',
    '2026-09-24T01:48:05.472608Z ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed, when AuthRequired(AuthRequiredError { www_authenticate_header: "Bearer resource_metadata=https://mcp.context7.com/.well-known/oauth-protected-resource" })',
    'ERROR: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-6-astra\' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again."}}'
  ].join('\n');
  const gemini = [
    'Warning: True color (24-bit) support not detected.',
    'Error authenticating: IneligibleTierError: This client is no longer supported for Gemini Code Assist for individuals. To continue using Gemini, please migrate to the Antigravity suite of products: https://antigravity.google',
    '    at throwIneligibleOrProjectIdError (file:///C:/x/chunk.js:307474:11)',
    'Ripgrep is not available. Falling back to GrepTool.'
  ].join('\n');
  const agy = 'jetski: no output produced — a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied.';

  assert.match(keyErrorLine(codex), /requires a newer version of Codex/);
  assert.match(keyErrorLine(gemini), /no longer supported/);
  assert.match(fixHint('claude', 'Claude Code', claude) ?? '', /sign in again.*type claude auth login/);
  assert.match(fixHint('codex', 'OpenAI Codex', codex) ?? '', /out of date/);
  assert.match(fixHint('gemini', 'Google Gemini', gemini) ?? '', /Antigravity/);
  assert.match(fixHint('agy', 'Google Antigravity', agy) ?? '', /needs your approval/);
  assert.strictEqual(fixHint('opencode', 'OpenCode', 'TypeError: cannot read x'), null);
});

test('Automatic mode does not stick with Ollama just because it ran the last step', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmesh-sticky-'));
  const selector = new AgentSelector(dir, false, freshConfig({ priority: ['agy', 'ollama'] }));
  const agy = new ScriptedAdapter('agy', ok);
  const ollama = new ScriptedAdapter('ollama', ok);
  selector.register(agy);
  selector.register(ollama);
  const task = new TaskStore(dir).createTask('t', ['r']);
  task.currentAgent = 'ollama';

  const res = await selector.executeTask(task, 'edit a file');
  assert.strictEqual(res.agent, 'agy');
  assert.strictEqual(ollama.calls, 0);
});

test('OpenCode without a provider gets a /connect hint, and colour codes are stripped', async () => {
  const { keyErrorLine, fixHint } = await import('../router/error-hints.js');
  // Captured from a real OpenCode run on 2026-09-23.
  const raw = "\u001b[91m\u001b[1mError: \u001b[0mGoogle Generative AI API key is missing. Pass it using the 'apiKey' parameter or the GOOGLE_GENERATIVE_AI_API_KEY environment variable.";
  assert.ok(!keyErrorLine(raw).includes('\u001b'));
  assert.match(fixHint('opencode', 'OpenCode', raw) ?? '', /type opencode, then type \/connect/);
});

test('A prompt that mentions "rate limit" and gets echoed back is not mistaken for a real rate limit', async () => {
  const { RateLimiter } = await import('../router/rate-limiter.js');
  const rl = new RateLimiter(fs.mkdtempSync(path.join(os.tmpdir(), 'agentmesh-rl-echo-')));
  const prompt = 'Add rate limiting to my API.\nReturn 429 when a client makes too many requests.';
  // Shape of a real Codex failure log: header, echoed prompt, then the actual error.
  const codexLog = `OpenAI Codex v0.144.6\n--------\nuser\n${prompt}\nERROR: {"status":400,"message":"The model requires a newer version of Codex."}`;
  assert.strictEqual(rl.isRateLimit(codexLog, prompt), false);
  assert.strictEqual(rl.isRateLimit(`user\n${prompt}\nERROR: 429 Too Many Requests`, prompt), true);
});

test('Dashboard script parses (a syntax error blanks the whole page)', async () => {
  const vm = await import('node:vm');
  const html = fs.readFileSync(new URL('../../src/ui/dashboard.html', import.meta.url), 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(scripts.length > 0);
  for (const code of scripts) assert.doesNotThrow(() => new vm.Script(code));
});

test('Per-agent model is passed as --model, and a value that looks like a flag is refused', async () => {
  installFakeCli('claude');
  const res = await new ClaudeAdapter().execute('hi', { timeoutMs: 20_000, model: 'sonnet' });
  assert.deepStrictEqual(JSON.parse(res.output).args, ['-p', '--permission-mode', 'acceptEdits', '--model', 'sonnet']);

  const cfg = freshConfig({ models: { claude: 'sonnet', codex: '--dangerously-bypass-approvals-and-sandbox', ollama: 'x' } });
  assert.deepStrictEqual(cfg.get().models, { claude: 'sonnet' });
});

test('"Out of usage credits" counts as a quota limit with a model-switch hint', async () => {
  const { RateLimiter } = await import('../router/rate-limiter.js');
  const { fixHint } = await import('../router/error-hints.js');
  // Captured from real Claude Code runs on 2026-09-24.
  const raw = "You're out of usage credits. Switch to another model, or manage usage credits at claude.ai/settings/usage?from=cc_cli_limit_message, to continue.";
  const rl = new RateLimiter(fs.mkdtempSync(path.join(os.tmpdir(), 'agentmesh-rl-credits-')));
  assert.strictEqual(rl.isRateLimit(raw), true);
  assert.strictEqual(rl.isRateLimit('API Error: Fable 5 requires usage credits. Update Claude Code to the latest version to learn more'), true);
  assert.match(fixHint('claude', 'Claude Code', raw) ?? '', /Settings → Models.*sonnet or opus/);
});

// The 24 cases from the routing experiment (labels: does fulfilling it need file changes?).
const ROUTING_CASES: [string, 'read' | 'edit'][] = [
  ['Explain what this project does and how the files fit together', 'read'],
  ['What does the function calculateTotal in cart.js do?', 'read'],
  ['Summarize the changes made in the last step', 'read'],
  ['Write a commit message for these changes', 'read'],
  ["Why is the login page slow? Don't change anything, just tell me", 'read'],
  ['Is there anything insecure about how passwords are stored here?', 'read'],
  ['Which file should I edit to change the footer text?', 'read'],
  ['List the dependencies this project uses', 'read'],
  ['How do I run this project on my computer?', 'read'],
  ['Review index.html and tell me what you would improve', 'read'],
  ['Compare the two approaches in utils.js and recommend one', 'read'],
  ['What does this error mean: TypeError: undefined is not a function', 'read'],
  ['Add a contact form to the homepage that emails me the message', 'edit'],
  ['Fix the bug where the cart total is wrong', 'edit'],
  ['Change the button color to blue', 'edit'],
  ['Write a README.md that explains how to run this project', 'edit'],
  ['Rename the function getData to fetchUserData everywhere', 'edit'],
  ['Create a new page called about.html with our story', 'edit'],
  ['Add tests for the login function', 'edit'],
  ['Make the site work on phones', 'edit'],
  ['Translate the homepage into Spanish', 'edit'],
  ['Delete the unused images folder', 'edit'],
  ['Update the copyright year in the footer to 2026', 'edit'],
  ['Can you make the header sticky?', 'edit'],
  // Found in a live run: 'do not change anything else' limits an edit, it doesn't forbid one.
  ['Append exactly one new line at the end of RELAY.md: 7. Test line. Do not change anything else.', 'edit'],
  ["Fix the typo in the footer. Don't touch any other files.", 'edit']
];

test('Routing rule never sends a request that needs file changes down the read-only path', async () => {
  const { classifyByRule } = await import('../router/task-classifier.js');
  let correct = 0;
  for (const [q, want] of ROUTING_CASES) {
    const got = classifyByRule(q);
    if (got.kind === want) correct++;
    if (want === 'edit') assert.strictEqual(got.kind, 'edit', `edit request routed read-only: ${q}`);
    if (got.certainty === 'clear') assert.strictEqual(got.kind, want, `rule was confidently wrong: ${q}`);
  }
  assert.ok(correct >= 20, `rule-only accuracy ${correct}/${ROUTING_CASES.length}`);
});

test('Smart routing: questions go to Ollama read-only, edits never go to Ollama', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmesh-route-'));
  const seen: { agent: AgentId; permission?: string }[] = [];
  const record = (agent: AgentId, result = ok) => new ScriptedAdapter(agent, async (_p, opts) => { seen.push({ agent, permission: opts.permission }); return result(); });
  const selector = new AgentSelector(dir, false, freshConfig({ priority: ['ollama', 'agy'], smartRouting: true }));
  selector.register(record('ollama'));
  selector.register(record('agy'));
  const task = new TaskStore(dir).createTask('t', ['r']);

  const q = await selector.executeTask(task, 'Explain what this project does');
  assert.strictEqual(q.agent, 'ollama');
  assert.strictEqual(q.route?.kind, 'read');
  assert.strictEqual(seen.at(-1)?.permission, 'readonly');

  const e = await selector.executeTask(task, 'Add a contact form to the homepage');
  assert.strictEqual(e.agent, 'agy');
  assert.strictEqual(seen.filter((s) => s.agent === 'ollama').length, 1, 'Ollama was not called for the edit');
  assert.strictEqual(seen.at(-1)?.permission, 'edit');

  const redo = await selector.executeTask(task, 'Explain what this project does', undefined, { forceEdit: true });
  assert.strictEqual(redo.agent, 'agy');
});

test('Smart routing: if Ollama fails on a question, the next agent answers read-only', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmesh-route-fallback-'));
  let agyPermission: string | undefined;
  const selector = new AgentSelector(dir, false, freshConfig({ priority: ['ollama', 'agy'], smartRouting: true }));
  selector.register(new ScriptedAdapter('ollama', async () => ({ success: false, output: '', error: 'Ollama error: model crashed', durationMs: 1 })));
  selector.register(new ScriptedAdapter('agy', async (_p, opts) => { agyPermission = opts.permission; return { success: true, output: 'answer', durationMs: 1 }; }));

  const res = await selector.executeTask(new TaskStore(dir).createTask('t', ['r']), 'What does index.html do?');
  assert.strictEqual(res.agent, 'agy');
  assert.strictEqual(agyPermission, 'readonly');
});

test('Choosing a mode applies its defaults; free mode never lists paid-plan agents', () => {
  const cfg = freshConfig();
  assert.strictEqual(cfg.get().mode, null, 'no mode until the person chooses');
  const free = cfg.setMode('free');
  assert.strictEqual(free.mode, 'free');
  assert.strictEqual(free.smartRouting, true);
  assert.ok(!free.priority.includes('claude') && !free.priority.includes('codex'));
  const paid = cfg.setMode('subscriptions');
  assert.deepStrictEqual(paid.priority.slice(0, 2), ['claude', 'codex']);
  assert.strictEqual(paid.smartRouting, false);
});

test('Suggested mode: a working paid-plan CLI means "I pay for AI"; a broken one does not', async () => {
  const { suggestMode } = await import('../ui/server.js');
  assert.strictEqual(suggestMode([{ id: 'claude', available: true }]).mode, 'subscriptions');
  assert.match(suggestMode([{ id: 'claude', available: true }]).reason, /Claude Code/);
  assert.strictEqual(suggestMode([{ id: 'claude', available: true, hint: 'needs you to sign in again' }, { id: 'agy', available: true }]).mode, 'free');
  assert.strictEqual(suggestMode([{ id: 'ollama', available: true }]).mode, 'free');
});
