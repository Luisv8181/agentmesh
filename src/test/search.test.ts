import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ProjectSearch, toFtsQuery } from '../search/project-search.js';
import { BatonStore } from '../baton/baton-store.js';
import { TaskStore } from '../state/task-store.js';

process.env.AGENTMESH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmesh-home-'));

function project(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmesh-search-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>Rosa’s Bakery</h1><p>Fresh sourdough every morning.</p>');
  fs.writeFileSync(path.join(dir, '.env'), 'STRIPE_SECRET=sk_live_opening_hours_secret');
  new BatonStore(dir).addBrief('claude', '=== MESH BRIEF ===\nProject: Bakery site\nDecisions: orders go to orders@rosasbakery.com\nNext steps: add opening hours\n=== END MESH BRIEF ===');
  const tasks = new TaskStore(dir);
  const task = tasks.createTask('t', ['r']);
  task.runs = [{ runId: 'r1', instruction: 'Build the order form', agent: 'agy', success: true, output: 'Added a form that emails orders', handoffs: [], filesChanged: ['index.html'], startedAt: 1, durationMs: 1 }];
  tasks.saveTask(task);
  return dir;
}

test('Search finds handoff notes, agent steps and project files, ranked', () => {
  const s = new ProjectSearch(project());
  const note = s.search('opening hours');
  assert.strictEqual(note[0]?.kind, 'note');
  assert.match(note[0].snippet, /⟦opening⟧ ⟦hours⟧/);
  assert.strictEqual(s.search('order form')[0]?.kind, 'step');
  assert.strictEqual(s.search('sourdough')[0]?.path, 'index.html');
  assert.ok(s.search('orders@rosasbakery.com').length > 0, 'emails are searchable');
});

test('Search never indexes secrets (.env, keys)', () => {
  const s = new ProjectSearch(project());
  assert.deepStrictEqual(s.search('sk_live'), []);
  assert.ok(s.search('opening hours').every((h) => h.path !== '.env'));
});

test('Search picks up changes without restarting', () => {
  const dir = project();
  const s = new ProjectSearch(dir);
  assert.deepStrictEqual(s.search('croissant'), []);
  fs.writeFileSync(path.join(dir, 'menu.md'), '# Menu\n- Croissant\n- Baguette');
  assert.strictEqual(s.search('croissant')[0]?.path, 'menu.md');
});

test('Odd input is sanitized instead of crashing the query engine', () => {
  const s = new ProjectSearch(project());
  for (const q of ['"', 'AND OR NOT', 'hours*', 'NEAR(open hours)', '💥🔥', '', '  ', 'opening" OR "x']) {
    assert.doesNotThrow(() => s.search(q), `query: ${q}`);
  }
  assert.strictEqual(toFtsQuery('   '), null);
  assert.deepStrictEqual(toFtsQuery('Opening Hours!')?.all, '"opening"* "hours"*');
});
