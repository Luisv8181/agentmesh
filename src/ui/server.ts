import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { AgentSelector } from '../router/agent-selector.js';
import { TaskStore } from '../state/task-store.js';
import { globalUsageMonitor } from '../router/usage-monitor.js';
import { globalTokenTracker } from '../router/token-tracker.js';
import { AgentId } from '../types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface UiServerInstance {
  server: http.Server;
  port: number;
  url: string;
  close: () => Promise<void>;
}

export function startUiServer(
  port = 3333,
  workspaceRoot = process.cwd(),
  safeMode = false
): Promise<UiServerInstance> {
  const selector = new AgentSelector(workspaceRoot, safeMode);
  const taskStore = new TaskStore(workspaceRoot);

  return new Promise((resolve, reject) => {
    const sseClients: http.ServerResponse[] = [];

    // Telemetry SSE broadcasting
    const telemetryHandler = (ev: any) => {
      const data = `data: ${JSON.stringify({ type: 'event', event: ev })}\n\n`;
      sseClients.forEach((client) => {
        try { client.write(data); } catch {}
      });
    };

    const tickHandler = (metrics: any) => {
      const data = `data: ${JSON.stringify({ type: 'tick', metrics })}\n\n`;
      sseClients.forEach((client) => {
        try { client.write(data); } catch {}
      });
    };

    globalUsageMonitor.on('telemetry', telemetryHandler);
    globalUsageMonitor.on('tick', tickHandler);

    const server = http.createServer(async (req, res) => {
      const parsedUrl = new URL(req.url || '/', `http://localhost:${port}`);
      const pathname = parsedUrl.pathname;

      // CORS headers
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      // Root HTML Dashboard
      if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        let htmlPath = path.join(__dirname, 'dashboard.html');
        // Handle dist vs src directory differences
        if (!fs.existsSync(htmlPath)) {
          htmlPath = path.join(__dirname, '..', '..', 'src', 'ui', 'dashboard.html');
        }

        try {
          const content = fs.readFileSync(htmlPath, 'utf8');
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(content);
        } catch (err: any) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end(`Error loading dashboard: ${err.message}`);
        }
        return;
      }

      // API: Live Status
      if (req.method === 'GET' && pathname === '/api/status') {
        const payload = {
          agents: selector.getStatuses(),
          metrics: globalUsageMonitor.getAllMetrics(),
          tasks: taskStore.listTasks(),
          safeMode: selector.isSafeMode(),
          claudeLiveStats: globalTokenTracker.readClaudeStats(),
          codexLiveStats: globalTokenTracker.readCodexStats()
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
        return;
      }

      // API: Telemetry SSE Stream
      if (req.method === 'GET' && pathname === '/api/telemetry/stream') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive'
        });

        // Send recent backlog
        const recent = globalUsageMonitor.getRecentEvents(20);
        recent.forEach((ev) => {
          res.write(`data: ${JSON.stringify({ type: 'event', event: ev })}\n\n`);
        });

        sseClients.push(res);
        req.on('close', () => {
          const idx = sseClients.indexOf(res);
          if (idx !== -1) sseClients.splice(idx, 1);
        });
        return;
      }

      // API: Toggle Safe Mode
      if (req.method === 'POST' && pathname === '/api/mode') {
        const body = await parseJsonBody(req);
        if (typeof body.safeMode === 'boolean') {
          selector.setSafeMode(body.safeMode);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, safeMode: selector.isSafeMode() }));
        return;
      }

      // API: Reset Cooldown
      if (req.method === 'POST' && pathname === '/api/reset-cooldown') {
        const body = await parseJsonBody(req);
        if (body.agentId) {
          selector.resetAgent(body.agentId as AgentId);
        } else {
          selector.resetCooldowns();
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return;
      }

      // API: Create Task
      if (req.method === 'POST' && pathname === '/api/tasks') {
        const body = await parseJsonBody(req);
        const title = body.title || 'Untitled Task';
        const reqs = Array.isArray(body.requirements) ? body.requirements : [];
        const task = taskStore.createTask(title, reqs);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(task));
        return;
      }

      // API: Run Instruction
      if (req.method === 'POST' && pathname === '/api/run') {
        const body = await parseJsonBody(req);
        const instruction = (body.instruction || '').trim();
        const forced = body.forcedAgent ? (body.forcedAgent as AgentId) : undefined;

        if (!instruction) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Instruction is required' }));
          return;
        }

        let task = taskStore.getCurrentTask();
        if (!task) {
          task = taskStore.createTask(instruction.slice(0, 50), [instruction]);
        }

        try {
          const result = await selector.executeTask(task, instruction, forced);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: err.message }));
        }
        return;
      }

      // 404
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    });

    server.on('error', (err) => {
      reject(err);
    });

    server.listen(port, () => {
      const url = `http://localhost:${port}`;
      resolve({
        server,
        port,
        url,
        close: () => {
          globalUsageMonitor.off('telemetry', telemetryHandler);
          globalUsageMonitor.off('tick', tickHandler);
          sseClients.forEach((c) => {
            try { c.end(); } catch {}
          });
          return new Promise((r) => server.close(() => r()));
        }
      });
    });
  });
}

function parseJsonBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}
