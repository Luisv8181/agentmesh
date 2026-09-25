import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { PROTOCOL_TEXT, parseBrief, BRIEF_START, BRIEF_END } from '../baton/protocol.js';
import { BatonStore } from '../baton/baton-store.js';
import { TaskStore } from '../state/task-store.js';
import { spawnSync as spawnSyncForGit } from 'child_process';
// Tests that need Git skip (with a reason) on PCs without it, so setup isn't blocked by them.
const NEEDS_GIT = spawnSyncForGit('git', ['--version']).status === 0 ? {} : { skip: 'Git is not installed on this PC' };


process.env.AGENTMESH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmesh-home-'));

// Shape of a real reply: chatter around the block, markdown bold labels, files as a bullet list.
const CHATGPT_REPLY = `Sure! Here's the handoff:

${BRIEF_START}
**Project:** Bakery website
**Goal:** Simple site for Rosa's Bakery with an order form
**Decisions:** Plain HTML/CSS, no framework
**Done:** Homepage layout; menu section
**Open questions:** Which email should orders go to?
**Next steps:** 1. Build the order form 2. Add opening hours
**Key files:**
- index.html
- styles.css (updated colors)
- menu-photos.zip
**Code to carry over:** see Key files
${BRIEF_END}

Let me know if you need anything else!`;

test('Protocol fits in ChatGPT free custom instructions (1,500 chars) with room to spare', () => {
  assert.ok(PROTOCOL_TEXT.length <= 1200, `protocol is ${PROTOCOL_TEXT.length} chars`);
});

test('Brief parser handles a real-looking reply: strips chatter, reads project and key files', () => {
  const b = parseBrief(CHATGPT_REPLY);
  assert.strictEqual(b.wellFormed, true);
  assert.ok(b.text.startsWith(BRIEF_START) && b.text.endsWith(BRIEF_END));
  assert.ok(!b.text.includes('Let me know'));
  assert.strictEqual(b.project, 'Bakery website');
  assert.deepStrictEqual(b.keyFiles, ['index.html', 'styles.css', 'menu-photos.zip']);
});

test('A reply without the MESH markers is kept but flagged (protocol probably not installed)', () => {
  const b = parseBrief('We built the homepage and the menu. Next: order form.');
  assert.strictEqual(b.wellFormed, false);
  assert.deepStrictEqual(b.keyFiles, []);
});

test('Baton ledger: knows what each site has, and suggests only what is missing or changed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmesh-baton-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>v1</h1>');
  fs.writeFileSync(path.join(dir, 'styles.css'), 'body{}');
  const store = new BatonStore(dir);

  store.addBrief('chatgpt', CHATGPT_REPLY);
  let k = store.knowledge();
  assert.strictEqual(k.chatgpt.upToDate, true);
  assert.match(k.claude.summary, /Hasn’t seen/);

  // Moving to Claude: both named files exist and Claude has never seen them. The zip isn't in the project.
  let next = store.continueOn('claude');
  assert.deepStrictEqual(next.files.map((f) => f.path).sort(), ['index.html', 'styles.css']);
  assert.ok(next.message.startsWith('mesh start'));
  assert.ok(next.message.includes('Bakery website') && next.message.includes('I\'m attaching: '));

  store.recordPass('claude', next.files.map((f) => f.path));
  assert.deepStrictEqual(store.suggestFiles('claude'), [], 'nothing new to upload right after the pass');

  // A coding agent changes index.html: Claude's copy is now stale; that work shows up in the next handoff.
  const tasks = new TaskStore(dir);
  const task = tasks.createTask('t', ['r']);
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>v2 with order form</h1>');
  task.runs = [{ runId: 'r1', instruction: 'Build the order form', agent: 'agy', success: true, output: 'Added an order form to index.html', handoffs: [], filesChanged: ['index.html'], startedAt: Date.now() + 1, durationMs: 1 }];
  tasks.saveTask(task);

  next = store.continueOn('claude');
  assert.deepStrictEqual(next.files.map((f) => f.path), ['index.html']);
  assert.match(next.files[0].reason, /changed since Claude last saw it|named in the latest brief/);
  assert.ok(next.message.includes('Build the order form'), 'agent work since the brief is included');
});

test('Real "mesh wrap" reply from Claude (value on the line below the label) parses fully', () => {
  // Captured 2026-09-24: Claude Sonnet given the protocol + a bakery chat + "mesh wrap".
  const raw = fs.readFileSync(new URL('../../src/test/fixtures-claude-brief.txt', import.meta.url), 'utf8');
  const b = parseBrief(raw);
  assert.strictEqual(b.wellFormed, true);
  assert.strictEqual(b.project, "Rosa's Bakery website");
  assert.deepStrictEqual(b.keyFiles, ['index.html', 'styles.css']);
});

test('The site that wrote a brief already has its key files; a later change is flagged with the right reason', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmesh-baton-writer-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>v1</h1>');
  fs.writeFileSync(path.join(dir, 'styles.css'), 'body{}');
  const store = new BatonStore(dir);
  store.addBrief('claude', CHATGPT_REPLY);
  assert.deepStrictEqual(store.suggestFiles('claude'), [], 'Claude made/shared these files already');

  fs.writeFileSync(path.join(dir, 'styles.css'), 'body{color:brown}');
  assert.deepStrictEqual(store.suggestFiles('claude'), [{ path: 'styles.css', reason: 'changed since Claude last saw it' }]);
});

test('With the project on GitHub, Claude and Gemini get "Sync / Import code" instead of files; ChatGPT still gets files', NEEDS_GIT, async () => {
  const cp = await import('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmesh-baton-gh-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>v1</h1>');
  fs.writeFileSync(path.join(dir, 'styles.css'), 'body{}');
  cp.spawnSync('git', ['init', '-b', 'main'], { cwd: dir });
  cp.spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/rosa/bakery-site.git'], { cwd: dir });
  const store = new BatonStore(dir);
  store.addBrief('chatgpt', CHATGPT_REPLY);

  const claude = store.continueOn('claude');
  assert.strictEqual(claude.github?.webUrl, 'https://github.com/rosa/bakery-site');
  assert.deepStrictEqual(claude.files, []);
  assert.match(claude.github!.how, /Add from GitHub|Sync/);
  assert.strictEqual(claude.github!.inSync, false, 'nothing uploaded yet');
  assert.ok(claude.message.includes('github.com/rosa/bakery-site'));
  assert.match(store.continueOn('gemini').github!.how, /Import code/);
  assert.strictEqual(store.continueOn('chatgpt').github, undefined, 'ChatGPT free plan cannot read GitHub');

  store.recordPass('claude', [], true);
  assert.deepStrictEqual(store.suggestFiles('claude'), [], 'a GitHub pass counts every file as seen');
});
