import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import * as vm from 'vm';
import { startUiServer } from '../ui/server.js';

process.env.AGENTMESH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmesh-home-'));
// Load the extension's plain script the way the browser does, as a classic script defining a global.
const sandbox: { AgentMeshLib?: any; URL: typeof URL } = { URL };
vm.runInNewContext(fs.readFileSync(new URL('../../extension/lib.js', import.meta.url), 'utf8'), Object.assign(sandbox, { globalThis: sandbox }));
const lib = sandbox.AgentMeshLib;

test('Extension helpers: site detection, brief extraction, pairing codes', () => {
  assert.strictEqual(lib.siteOf('https://chatgpt.com/c/123'), 'chatgpt');
  assert.strictEqual(lib.siteOf('https://claude.ai/chat/abc'), 'claude');
  assert.strictEqual(lib.siteOf('https://gemini.google.com/app/x'), 'gemini');
  assert.strictEqual(lib.siteOf('https://evil-chatgpt.com/'), null);
  assert.strictEqual(lib.siteOf('not a url'), null);

  const page = `mesh start\n=== MESH BRIEF ===\nProject: old\n=== END MESH BRIEF ===\nassistant: here you go\n=== MESH BRIEF ===\nProject: new\nKey files:\nindex.html\n=== END MESH BRIEF ===`;
  const briefs = lib.allBriefs(page);
  assert.strictEqual(briefs.length, 2, 'the pasted old brief and the new reply are told apart by count');
  assert.match(briefs[1], /Project: new/);
  assert.strictEqual(lib.allBriefs('=== MESH BRIEF ===\nstill streaming…').length, 0, 'an unfinished brief is not captured');

  assert.deepStrictEqual({ ...lib.parsePairingCode(' AM1-3333-abcdefghijklmnopqrstuvwxyz012345 ') }, { port: 3333, token: 'abcdefghijklmnopqrstuvwxyz012345' });
  assert.strictEqual(lib.parsePairingCode('AM1-3333-short'), null);
  assert.strictEqual(lib.parsePairingCode('hello'), null);
});

function req(port: number, method: string, p: string, headers: Record<string, string>, body?: unknown) {
  return new Promise<{ status: number; json: any; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let s = '';
      res.on('data', (d) => (s += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: s ? JSON.parse(s) : null, headers: res.headers }));
    });
    r.on('error', reject);
    r.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

test('Extension access: pairing token reaches only the baton actions, only from an extension', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmesh-ext-'));
  const port = 3473;
  const ui = await startUiServer(port, dir, true);
  const EXT = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
  try {
    const pairing = await req(port, 'GET', '/api/extension', { 'x-agentmesh-token': ui.token });
    const [, , extToken] = pairing.json.code.match(/^AM1-(\d+)-(.+)$/);
    const ext = { Origin: EXT, 'x-agentmesh-ext': extToken };

    let r = await req(port, 'GET', '/api/ext/state', ext);
    assert.strictEqual(r.status, 200);
    assert.ok(r.json.knowledge.claude);
    assert.strictEqual(r.headers['access-control-allow-origin'], EXT);

    r = await req(port, 'POST', '/api/ext/brief', { ...ext, 'Content-Type': 'application/json' }, { from: 'claude', text: '=== MESH BRIEF ===\nProject: X\n=== END MESH BRIEF ===' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.wellFormed, true);

    // A web page can't use it, even with the token.
    r = await req(port, 'GET', '/api/ext/state', { Origin: 'https://evil.example', 'x-agentmesh-ext': extToken });
    assert.strictEqual(r.status, 403);
    // Wrong or missing token.
    assert.strictEqual((await req(port, 'GET', '/api/ext/state', { Origin: EXT, 'x-agentmesh-ext': 'nope' })).status, 401);
    // The pairing token is not a dashboard token: no running agents, no settings.
    assert.strictEqual((await req(port, 'POST', '/api/runs', { ...ext, 'x-agentmesh-token': extToken, 'Content-Type': 'application/json' }, { instruction: 'x' })).status, 403);
    assert.strictEqual((await req(port, 'POST', '/api/runs', { 'x-agentmesh-token': extToken, 'Content-Type': 'application/json' }, { instruction: 'x' })).status, 401);
    assert.strictEqual((await req(port, 'POST', '/api/ext/runs', { ...ext, 'Content-Type': 'application/json' }, { instruction: 'x' })).status, 404);
    assert.strictEqual((await req(port, 'POST', '/api/ext/config', { ...ext, 'Content-Type': 'application/json' }, { mode: 'free' })).status, 404);

    // Resetting the code disconnects the old one.
    await req(port, 'POST', '/api/extension/reset', { 'x-agentmesh-token': ui.token, 'Content-Type': 'application/json' }, {});
    assert.strictEqual((await req(port, 'GET', '/api/ext/state', ext)).status, 401);
  } finally {
    await ui.close();
  }
});

test('Extension manifest stays minimal: only the three AI sites + this PC, no broad permissions', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../../extension/manifest.json', import.meta.url), 'utf8'));
  assert.strictEqual(manifest.manifest_version, 3);
  assert.deepStrictEqual([...manifest.host_permissions].sort(), ['http://127.0.0.1/*', 'https://chatgpt.com/*', 'https://claude.ai/*', 'https://gemini.google.com/*']);
  assert.deepStrictEqual([...manifest.permissions].sort(), ['scripting', 'sidePanel', 'storage', 'tabs']);
  const all = JSON.stringify(manifest);
  for (const risky of ['<all_urls>', 'cookies', 'history', 'webRequest', 'clipboardRead', 'debugger', 'nativeMessaging']) {
    assert.ok(!all.includes(risky), `manifest must not request ${risky}`);
  }
  for (const f of ['lib.js', 'content.js', 'sidepanel.js', 'background.js', 'icon-16.png', 'icon-128.png']) {
    assert.ok(fs.existsSync(new URL(`../../extension/${f}`, import.meta.url)), `${f} exists`);
  }
  for (const f of ['lib.js', 'content.js', 'sidepanel.js', 'background.js']) {
    assert.doesNotThrow(() => new vm.Script(fs.readFileSync(new URL(`../../extension/${f}`, import.meta.url), 'utf8')), `${f} parses`);
  }
});
