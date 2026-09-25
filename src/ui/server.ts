import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as cp from 'child_process';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import { AgentSelector } from '../router/agent-selector.js';
import { TaskStore } from '../state/task-store.js';
import { ConfigStore, AgentMeshConfig, ALL_AGENTS, agentMeshHome } from '../state/config-store.js';
import { globalUsageMonitor } from '../router/usage-monitor.js';
import { globalTokenTracker } from '../router/token-tracker.js';
import { clearResolveCache, refreshPathFromSystem } from '../adapters/resolve-command.js';
import { BatonStore } from '../baton/baton-store.js';
import { ProjectSearch } from '../search/project-search.js';
import { githubStatus, saveToGitHub, connectGitHub } from '../workspace/github.js';
import { PROTOCOL_TEXT, SITE_INFO, WEB_SITES, WebSite } from '../baton/protocol.js';
import { AgentId, HandoffReason, RouteDecision, WorkExecutionResult } from '../types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAX_BODY_BYTES = 1_000_000;
const MAX_LIVE_OUTPUT = 200_000;
/** The unpacked browser extension ships next to dist/ in the repo. */
const EXTENSION_DIR = path.resolve(__dirname, '..', '..', 'extension');

export interface UiServerInstance {
  server: http.Server;
  port: number;
  url: string;
  /** Required on every /api request (header `x-agentmesh-token`, or `?token=` for the event stream). */
  token: string;
  close: () => Promise<void>;
}

interface ActiveRun {
  runId: string;
  taskId: string;
  instruction: string;
  startedAt: number;
  agent: AgentId | null;
  output: string;
  handoffs: { from: AgentId; to: AgentId; reason: HandoffReason; error: string }[];
  status: 'running' | 'finished';
  result?: WorkExecutionResult;
  route?: RouteDecision;
  abort: AbortController;
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function startUiServer(port = 3333, workspaceRoot = process.cwd(), safeMode = false): Promise<UiServerInstance> {
  const token = crypto.randomBytes(24).toString('base64url');
  const config = new ConfigStore();
  let selector = new AgentSelector(workspaceRoot, safeMode, config);
  let taskStore = new TaskStore(workspaceRoot);
  let run: ActiveRun | null = null;
  let searchIndex: { root: string; search: ProjectSearch } | null = null;
  config.rememberWorkspace(workspaceRoot);

  // Probe CLIs in the background so the first page load is fast.
  void selector.getStatuses();

  const sseClients = new Set<http.ServerResponse>();
  const broadcast = (payload: unknown) => {
    const data = `data: ${JSON.stringify(payload)}\n\n`;
    for (const client of sseClients) {
      try { client.write(data); } catch {}
    }
  };

  const telemetryHandler = (event: unknown) => broadcast({ type: 'event', event });
  const tickHandler = (metrics: unknown) => broadcast({ type: 'tick', metrics });
  globalUsageMonitor.on('telemetry', telemetryHandler);
  globalUsageMonitor.on('tick', tickHandler);
  const heartbeat = setInterval(() => {
    for (const client of sseClients) {
      try { client.write(': ping\n\n'); } catch {}
    }
  }, 25_000);

  const runSnapshot = () =>
    run && {
      runId: run.runId,
      taskId: run.taskId,
      instruction: run.instruction,
      startedAt: run.startedAt,
      agent: run.agent,
      output: run.output,
      handoffs: run.handoffs,
      status: run.status,
      route: run.route,
      result: run.result
    };

  const startRun = (instruction: string, forcedAgent: AgentId | undefined, taskId: string | undefined, forceEdit = false): ActiveRun => {
    if (run?.status === 'running') throw new HttpError(409, 'An agent is already working. Wait for it to finish or press Stop.');
    if (forcedAgent && !ALL_AGENTS.includes(forcedAgent)) throw new HttpError(400, `Unknown agent "${forcedAgent}"`);

    let task = taskId ? taskStore.getTask(taskId) : taskStore.getCurrentTask();
    if (taskId && !task) throw new HttpError(404, 'Task not found');
    if (!task || task.status === 'completed') {
      task = taskStore.createTask(titleFrom(instruction), [instruction]);
    }
    taskStore.setCurrentTaskId(task.taskId);

    const active: ActiveRun = {
      runId: `run-${uuidv4().slice(0, 8)}`,
      taskId: task.taskId,
      instruction,
      startedAt: Date.now(),
      agent: null,
      output: '',
      handoffs: [],
      status: 'running',
      abort: new AbortController()
    };
    run = active;
    broadcast({ type: 'run', kind: 'started', run: runSnapshot() });

    const runTask = task;
    void (async () => {
      let result: WorkExecutionResult;
      try {
        result = await selector.executeTask(runTask, instruction, forcedAgent, {
          runId: active.runId,
          signal: active.abort.signal,
          forceEdit,
          onRoute: (route) => {
            active.route = route;
            broadcast({ type: 'run', kind: 'route', runId: active.runId, route });
          },
          onAgentStart: (agentId) => {
            active.agent = agentId;
            broadcast({ type: 'run', kind: 'agent', runId: active.runId, agentId });
          },
          onOutput: (agentId, text) => {
            if (active.output.length < MAX_LIVE_OUTPUT) active.output += text;
            broadcast({ type: 'run', kind: 'output', runId: active.runId, agentId, text });
          },
          onHandoff: (from, to, reason, error) => {
            active.handoffs.push({ from, to, reason, error: error.slice(0, 500) });
            // The next agent starts from scratch; the live view shows its output separately.
            active.output = '';
            broadcast({ type: 'run', kind: 'handoff', runId: active.runId, from, to, reason, error: error.slice(0, 500) });
          }
        });
      } catch (err) {
        result = {
          success: false,
          agent: forcedAgent ?? 'ollama',
          output: '',
          error: err instanceof Error ? err.message : String(err),
          handoffs: [],
          durationMs: Date.now() - active.startedAt
        };
      }
      active.status = 'finished';
      active.result = result;
      broadcast({ type: 'run', kind: 'finished', run: runSnapshot() });
    })();

    return active;
  };

  const switchWorkspace = (dir: string) => {
    if (run?.status === 'running') throw new HttpError(409, 'Stop the running agent before switching projects.');
    const resolved = path.resolve(dir.trim().replace(/^"(.*)"$/, '$1'));
    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolved);
    } catch {
      throw new HttpError(400, `Folder not found: ${resolved}`);
    }
    if (!stat.isDirectory()) throw new HttpError(400, `Not a folder: ${resolved}`);

    selector = new AgentSelector(resolved, selector.isSafeMode(), config);
    taskStore = new TaskStore(resolved);
    run = null;
    config.rememberWorkspace(resolved);
    return resolved;
  };

  const route = async (req: http.IncomingMessage, url: URL): Promise<unknown> => {
    const p = url.pathname;
    const m = req.method;

    if (m === 'GET' && p === '/api/state') {
      const current = taskStore.getCurrentTask();
      return {
        workspace: selector.workspaceRoot,
        safeMode: selector.isSafeMode(),
        config: config.get(),
        agents: await selector.getStatuses(),
        metrics: globalUsageMonitor.getAllMetrics(),
        tasks: taskStore.listTasks().map((t) => ({
          taskId: t.taskId,
          title: t.title,
          status: t.status,
          currentAgent: t.currentAgent,
          updatedAt: t.updatedAt,
          runs: t.runs?.length ?? 0
        })),
        currentTaskId: current?.taskId ?? null,
        suggestedMode: suggestMode(await selector.getStatuses()),
        run: runSnapshot(),
        usage: { claude: globalTokenTracker.readClaudeStats() ?? null, codex: globalTokenTracker.readCodexStats() ?? null },
        platform: process.platform
      };
    }

    const taskMatch = p.match(/^\/api\/tasks\/([^/]+)(?:\/(select|complete))?$/);
    if (taskMatch) {
      const [, id, action] = taskMatch;
      if (m === 'GET' && !action) {
        const task = taskStore.getTask(id);
        if (!task) throw new HttpError(404, 'Task not found');
        return task;
      }
      if (m === 'POST' && action === 'select') {
        const task = taskStore.getTask(id);
        if (!task) throw new HttpError(404, 'Task not found');
        if (task.status === 'completed') {
          task.status = 'in_progress';
          taskStore.saveTask(task);
        }
        taskStore.setCurrentTaskId(id);
        return task;
      }
      if (m === 'POST' && action === 'complete') {
        const task = taskStore.completeTask(id);
        if (!task) throw new HttpError(404, 'Task not found');
        return task;
      }
    }

    if (m === 'POST' && p === '/api/tasks') {
      const body = await readJson(req);
      const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim().slice(0, 120) : 'New task';
      const reqs = Array.isArray(body.requirements) ? body.requirements.filter((r: unknown) => typeof r === 'string') : [];
      return taskStore.createTask(title, reqs);
    }

    if (m === 'POST' && p === '/api/tasks/new') {
      taskStore.clearCurrentTask();
      return { ok: true };
    }

    if (m === 'POST' && p === '/api/runs') {
      const body = await readJson(req);
      const instruction = typeof body.instruction === 'string' ? body.instruction.trim() : '';
      if (!instruction) throw new HttpError(400, 'Type what you want done first.');
      const active = startRun(
        instruction,
        typeof body.forcedAgent === 'string' && body.forcedAgent ? (body.forcedAgent as AgentId) : undefined,
        typeof body.taskId === 'string' ? body.taskId : undefined,
        body.forceEdit === true
      );
      return { runId: active.runId, taskId: active.taskId };
    }

    if (m === 'POST' && p === '/api/runs/current/cancel') {
      if (run?.status === 'running') run.abort.abort();
      return { ok: true };
    }

    if (m === 'POST' && p === '/api/mode') {
      const body = await readJson(req);
      if (typeof body.safeMode === 'boolean') selector.setSafeMode(body.safeMode);
      return { safeMode: selector.isSafeMode() };
    }

    if (m === 'POST' && p === '/api/reset-cooldown') {
      const body = await readJson(req);
      if (typeof body.agentId === 'string' && ALL_AGENTS.includes(body.agentId as AgentId)) {
        selector.resetAgent(body.agentId as AgentId);
      } else {
        selector.resetCooldowns();
      }
      return { ok: true };
    }

    if (m === 'POST' && p === '/api/config') {
      const body = (await readJson(req)) as Partial<AgentMeshConfig>;
      if (body.mode === 'subscriptions' || body.mode === 'free') config.setMode(body.mode);
      const patch: Partial<AgentMeshConfig> = {};
      if (Array.isArray(body.priority)) patch.priority = body.priority;
      if (typeof body.autoCommit === 'boolean') patch.autoCommit = body.autoCommit;
      if (body.permission === 'edit' || body.permission === 'readonly') patch.permission = body.permission;
      if (typeof body.ollamaModel === 'string') patch.ollamaModel = body.ollamaModel;
      if (typeof body.onboarded === 'boolean') patch.onboarded = body.onboarded;
      if (body.models && typeof body.models === 'object') patch.models = body.models;
      if (typeof body.smartRouting === 'boolean') patch.smartRouting = body.smartRouting;
      const updated = config.update(patch);
      selector.reloadConfig();
      if (patch.ollamaModel) await selector.getStatuses(true);
      return updated;
    }

    if (m === 'POST' && p === '/api/agents/recheck') {
      refreshPathFromSystem();
      clearResolveCache();
      return { agents: await selector.getStatuses(true) };
    }

    if (m === 'GET' && p === '/api/search') {
      const q = (url.searchParams.get('q') ?? '').slice(0, 200);
      if (searchIndex?.root !== selector.workspaceRoot) searchIndex = { root: selector.workspaceRoot, search: new ProjectSearch(selector.workspaceRoot) };
      return { query: q, hits: searchIndex.search.search(q) };
    }

    // ---- Browser extension pairing (dashboard only) ----
    if (m === 'GET' && p === '/api/extension') {
      return { code: `AM1-${port}-${extensionToken()}`, folder: EXTENSION_DIR, installed: fs.existsSync(path.join(EXTENSION_DIR, 'manifest.json')) };
    }
    if (m === 'POST' && p === '/api/extension/open-folder') {
      const opener = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
      cp.spawn(opener, [EXTENSION_DIR], { stdio: 'ignore', detached: true }).unref();
      return { ok: true };
    }
    if (m === 'POST' && p === '/api/extension/reset') {
      return { code: `AM1-${port}-${extensionToken(true)}` };
    }

    // ---- GitHub (for people who don't use git) ----
    if (m === 'GET' && p === '/api/github') return githubStatus(selector.workspaceRoot);
    if (m === 'POST' && p === '/api/github/save') {
      const body = await readJson(req);
      const res = saveToGitHub(selector.workspaceRoot, typeof body.message === 'string' ? body.message.slice(0, 200) : undefined);
      return { ...res, status: githubStatus(selector.workspaceRoot) };
    }
    if (m === 'POST' && p === '/api/github/connect') {
      const body = await readJson(req);
      if (typeof body.url !== 'string') throw new HttpError(400, 'Paste your GitHub repository link.');
      const res = connectGitHub(selector.workspaceRoot, body.url);
      return { ...res, status: githubStatus(selector.workspaceRoot) };
    }

    // ---- Web-AI baton (ChatGPT / Claude / Gemini relay) ----
    const baton = new BatonStore(selector.workspaceRoot);
    const site = (v: unknown): WebSite => {
      if (typeof v === 'string' && (WEB_SITES as string[]).includes(v)) return v as WebSite;
      throw new HttpError(400, 'Unknown site');
    };

    if (m === 'GET' && p === '/api/baton') {
      const data = baton.get();
      return {
        protocol: PROTOCOL_TEXT,
        sites: SITE_INFO,
        knowledge: baton.knowledge(),
        briefs: data.briefs.slice().reverse()
      };
    }
    if (m === 'POST' && p === '/api/baton/brief') {
      const body = await readJson(req);
      if (typeof body.text !== 'string' || !body.text.trim()) throw new HttpError(400, 'Paste the reply you got after typing "mesh wrap".');
      return baton.addBrief(site(body.from), body.text.slice(0, 60_000));
    }
    if (m === 'POST' && p === '/api/baton/continue') {
      const body = await readJson(req);
      return baton.continueOn(site(body.to));
    }
    if (m === 'POST' && p === '/api/baton/pass') {
      const body = await readJson(req);
      const files = Array.isArray(body.files) ? body.files.filter((f: unknown): f is string => typeof f === 'string') : [];
      baton.recordPass(site(body.to), files.filter((f) => !f.includes('..')), body.viaGitHub === true);
      return { knowledge: baton.knowledge() };
    }
    if (m === 'POST' && p === '/api/baton/protocol') {
      const body = await readJson(req);
      baton.setProtocolInstalled(site(body.site), body.installed === true);
      return { knowledge: baton.knowledge() };
    }
    if (m === 'POST' && p === '/api/baton/file') {
      // A file downloaded from an AI website, dropped into the dashboard: saved into the project's from-ai/ folder.
      const body = await readJson(req, 15_000_000);
      const name = typeof body.name === 'string' ? path.basename(body.name).replace(/[<>:"|?*\x00-\x1f]/g, '_').slice(0, 120) : '';
      if (!name || name.startsWith('.')) throw new HttpError(400, 'Invalid file name');
      if (typeof body.base64 !== 'string') throw new HttpError(400, 'Missing file content');
      const dir = path.join(selector.workspaceRoot, 'from-ai');
      fs.mkdirSync(dir, { recursive: true });
      let target = path.join(dir, name);
      for (let i = 2; fs.existsSync(target); i++) target = path.join(dir, name.replace(/(\.[^.]*)?$/, ` (${i})$1`));
      fs.writeFileSync(target, Buffer.from(body.base64, 'base64'));
      return { saved: path.relative(selector.workspaceRoot, target).split(path.sep).join('/') };
    }

    if (m === 'POST' && p === '/api/workspace/open') {
      const opener = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
      cp.spawn(opener, [selector.workspaceRoot], { stdio: 'ignore', detached: true }).unref();
      return { ok: true };
    }

    if (m === 'POST' && p === '/api/workspace') {
      const body = await readJson(req);
      if (typeof body.path !== 'string' || !body.path.trim()) throw new HttpError(400, 'Paste a folder path first.');
      return { workspace: switchWorkspace(body.path) };
    }

    if (m === 'POST' && p === '/api/workspace/browse') {
      const picked = await pickFolder();
      if (picked === undefined) return { unsupported: true };
      if (!picked) return { cancelled: true };
      return { workspace: switchWorkspace(picked) };
    }

    throw new HttpError(404, 'Not found');
  };

  return new Promise((resolve, reject) => {
    const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    const allowedOrigins = new Set([...allowedHosts].map((h) => `http://${h}`));

    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(body));
      };

      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('X-Frame-Options', 'DENY');

      // DNS-rebinding guard: a hostile site that points its own domain at 127.0.0.1 still sends its own Host.
      if (!allowedHosts.has(req.headers.host ?? '')) {
        send(403, { error: 'Invalid host' });
        return;
      }

      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        serveDashboard(res, token);
        return;
      }

      if (!url.pathname.startsWith('/api/')) {
        send(404, { error: 'Not found' });
        return;
      }

      // Browser extension (side panel): its own pairing token, and only the baton actions.
      if (url.pathname.startsWith('/api/ext/')) {
        const extOrigin = req.headers.origin;
        if (extOrigin !== undefined && !EXTENSION_ORIGIN.test(extOrigin)) {
          send(403, { error: 'Only the AgentMesh browser extension can use this.' });
          return;
        }
        if (extOrigin) {
          res.setHeader('Access-Control-Allow-Origin', extOrigin);
          res.setHeader('Vary', 'Origin');
        }
        if (req.method === 'OPTIONS') {
          res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
          res.setHeader('Access-Control-Allow-Headers', 'content-type, x-agentmesh-ext');
          res.writeHead(204);
          res.end();
          return;
        }
        const presentedExt = req.headers['x-agentmesh-ext'];
        if (typeof presentedExt !== 'string' || !safeEqual(presentedExt, extensionToken())) {
          send(401, { error: 'Not connected. Copy the code again from AgentMesh → AI websites → Connect your browser.' });
          return;
        }
        if (req.method === 'POST' && !(req.headers['content-type'] ?? '').startsWith('application/json')) {
          send(415, { error: 'Content-Type must be application/json' });
          return;
        }
        const target = EXT_ROUTES[`${req.method} ${url.pathname}`];
        if (!target) {
          send(404, { error: 'Not found' });
          return;
        }
        try {
          if (target === 'state') {
            const baton = new BatonStore(selector.workspaceRoot);
            send(200, { project: path.basename(selector.workspaceRoot), knowledge: baton.knowledge(), latestBrief: baton.latestBrief()?.at ?? null });
          } else {
            send(200, await route(req, new URL(target, url)));
          }
        } catch (err) {
          if (err instanceof HttpError) send(err.status, { error: err.message });
          else send(500, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      const origin = req.headers.origin;
      if (origin && !allowedOrigins.has(origin)) {
        send(403, { error: 'Cross-origin requests are not allowed' });
        return;
      }

      const presented = url.pathname === '/api/events' ? url.searchParams.get('token') : req.headers['x-agentmesh-token'];
      if (typeof presented !== 'string' || !safeEqual(presented, token)) {
        send(401, { error: 'Missing or invalid token. Reload the dashboard.' });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        for (const ev of globalUsageMonitor.getRecentEvents(30)) {
          res.write(`data: ${JSON.stringify({ type: 'event', event: ev })}\n\n`);
        }
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        return;
      }

      if (req.method === 'POST' && !(req.headers['content-type'] ?? '').startsWith('application/json')) {
        send(415, { error: 'Content-Type must be application/json' });
        return;
      }

      try {
        send(200, await route(req, url));
      } catch (err) {
        if (err instanceof HttpError) send(err.status, { error: err.message });
        else send(500, { error: err instanceof Error ? err.message : String(err) });
      }
    });

    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve({
        server,
        port,
        token,
        url: `http://127.0.0.1:${port}`,
        close: () => {
          clearInterval(heartbeat);
          run?.abort.abort();
          globalUsageMonitor.off('telemetry', telemetryHandler);
          globalUsageMonitor.off('tick', tickHandler);
          for (const c of sseClients) {
            try { c.end(); } catch {}
          }
          return new Promise((r) => server.close(() => r()));
        }
      });
    });
  });
}

function serveDashboard(res: http.ServerResponse, token: string): void {
  let htmlPath = path.join(__dirname, 'dashboard.html');
  if (!fs.existsSync(htmlPath)) htmlPath = path.join(__dirname, '..', '..', 'src', 'ui', 'dashboard.html');
  try {
    const html = fs.readFileSync(htmlPath, 'utf8').replace('__AGENTMESH_TOKEN__', token);
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
    });
    res.end(html);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(`Error loading dashboard: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Recommends a mode from what's installed and working: a paid-plan CLI means "subscriptions". */
export function suggestMode(agents: { id: string; available: boolean; hint?: string }[]): { mode: 'subscriptions' | 'free'; reason: string } {
  const paid = agents.filter((a) => (a.id === 'claude' || a.id === 'codex') && a.available && !a.hint);
  if (paid.length) {
    const names = paid.map((a) => (a.id === 'claude' ? 'Claude Code' : 'OpenAI Codex')).join(' and ');
    return { mode: 'subscriptions', reason: `We found ${names} on this PC.` };
  }
  return { mode: 'free', reason: 'No paid AI tools found on this PC.' };
}

const EXTENSION_ORIGIN = /^(chrome|moz)-extension:\/\/[a-z0-9-]+$/i;

/** What the extension's pairing token can reach: the baton actions and nothing else. */
const EXT_ROUTES: Record<string, string> = {
  'GET /api/ext/state': 'state',
  'POST /api/ext/brief': '/api/baton/brief',
  'POST /api/ext/continue': '/api/baton/continue',
  'POST /api/ext/pass': '/api/baton/pass',
  'POST /api/ext/open-folder': '/api/workspace/open'
};

/** Long-lived pairing token for the browser extension, kept in ~/.agentmesh so pairing survives restarts. */
export function extensionToken(reset = false): string {
  const file = path.join(agentMeshHome(), 'extension-token');
  if (!reset) {
    try {
      const t = fs.readFileSync(file, 'utf8').trim();
      if (t.length >= 32) return t;
    } catch {
      // not paired yet
    }
  }
  const t = crypto.randomBytes(24).toString('base64url');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, t, { mode: 0o600 });
  return t;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function titleFrom(instruction: string): string {
  const firstLine = instruction.split(/\r?\n/)[0].trim();
  return firstLine.length > 60 ? `${firstLine.slice(0, 57)}…` : firstLine;
}

function readJson(req: http.IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > maxBytes) {
        reject(new HttpError(413, 'Request too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body || '{}');
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        reject(new HttpError(400, 'Invalid JSON'));
      }
    });
  });
}

/** Opens the OS folder picker on this machine. Resolves undefined when no picker is available, '' when cancelled. */
function pickFolder(): Promise<string | undefined> {
  let file: string;
  let args: string[];
  if (process.platform === 'win32') {
    file = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    args = [
      '-NoProfile', '-STA', '-Command',
      "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Add-Type -AssemblyName System.Windows.Forms; " +
        "$owner = New-Object System.Windows.Forms.Form -Property @{TopMost=$true}; " +
        "$d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = 'Choose the project folder AgentMesh should work in'; " +
        "if ($d.ShowDialog($owner) -eq 'OK') { [Console]::Out.Write($d.SelectedPath) }"
    ];
  } else if (process.platform === 'darwin') {
    file = 'osascript';
    args = ['-e', 'POSIX path of (choose folder with prompt "Choose the project folder AgentMesh should work in")'];
  } else {
    file = 'zenity';
    args = ['--file-selection', '--directory', '--title=Choose the project folder'];
  }
  return new Promise((resolve) => {
    cp.execFile(file, args, { windowsHide: false, timeout: 10 * 60_000 }, (err, stdout) => {
      if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') return resolve(undefined);
      resolve(stdout.trim());
    });
  });
}
