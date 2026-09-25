import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as cp from 'child_process';
import { attachRemote, githubStatus, parseGitHubUrl, explainPushError } from '../workspace/github.js';
import { spawnSync as spawnSyncForGit } from 'child_process';
// Tests that need Git skip (with a reason) on PCs without it, so setup isn't blocked by them.
const NEEDS_GIT = spawnSyncForGit('git', ['--version']).status === 0 ? {} : { skip: 'Git is not installed on this PC' };


const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const git = (cwd: string, ...args: string[]) => cp.spawnSync('git', args, { cwd, encoding: 'utf8' }).stdout.trim();

/** A project folder plus a bare repository standing in for GitHub. */
function setup() {
  const remote = tmp('agentmesh-remote-');
  cp.spawnSync('git', ['init', '--bare', '-b', 'main', remote]);
  const project = tmp('agentmesh-gh-project-');
  fs.writeFileSync(path.join(project, 'index.html'), '<h1>Bakery</h1>');
  fs.writeFileSync(path.join(project, '.env'), 'STRIPE_KEY=sk_live_123');
  fs.writeFileSync(path.join(project, 'credentials.json'), '{"token":"x"}');
  fs.mkdirSync(path.join(project, '.agentmesh'));
  fs.writeFileSync(path.join(project, '.agentmesh', 'baton.json'), '{}');
  return { remote, project };
}

test('Put on GitHub: sets up history, uploads the project, never uploads secrets or AgentMesh state', NEEDS_GIT, () => {
  const { remote, project } = setup();
  const res = attachRemote(project, remote, 'rosa-bakery');
  assert.strictEqual(res.ok, true, res.error);
  const uploaded = git(remote, 'ls-tree', '-r', '--name-only', 'main').split('\n');
  assert.ok(uploaded.includes('index.html') && uploaded.includes('.gitignore'));
  for (const secret of ['.env', 'credentials.json', '.agentmesh/baton.json']) assert.ok(!uploaded.includes(secret), `${secret} must not be uploaded`);
  assert.match(fs.readFileSync(path.join(project, '.gitignore'), 'utf8'), /\.agentmesh\//);
  // No git identity on the machine: commits use the GitHub username's no-reply address.
  assert.strictEqual(git(remote, 'log', '-1', '--format=%ae', 'main').endsWith('@users.noreply.github.com'), true);

  const s = githubStatus(project);
  assert.strictEqual(s.inSync, true);
  assert.deepStrictEqual(s.unsaved, []);
  assert.ok(s.skipped.includes('credentials.json'));
});

test('Save picks up changes and new files, and status reports them first', NEEDS_GIT, () => {
  const { remote, project } = setup();
  attachRemote(project, remote, 'rosa-bakery');
  fs.writeFileSync(path.join(project, 'index.html'), '<h1>Bakery v2</h1>');
  fs.writeFileSync(path.join(project, 'menu.md'), '# Menu');
  const before = githubStatus(project);
  assert.deepStrictEqual(before.unsaved.sort(), ['index.html', 'menu.md']);
  assert.strictEqual(before.inSync, false);

  assert.strictEqual(attachRemote(project, remote, 'rosa-bakery').ok, true);
  assert.ok(git(remote, 'ls-tree', '-r', '--name-only', 'main').includes('menu.md'));
  assert.strictEqual(githubStatus(project).inSync, true);
});

test('Never re-points a project that is already connected somewhere else', NEEDS_GIT, () => {
  const { remote, project } = setup();
  attachRemote(project, remote, 'a');
  const other = tmp('agentmesh-remote2-');
  cp.spawnSync('git', ['init', '--bare', other]);
  const res = attachRemote(project, other, 'a');
  assert.strictEqual(res.ok, false);
  assert.match(res.error ?? '', /already connected/);
});

test('A project folder inside some other repository is not treated as its own repo', NEEDS_GIT, () => {
  const outer = tmp('agentmesh-outer-');
  cp.spawnSync('git', ['init', outer]);
  const inner = path.join(outer, 'my-project');
  fs.mkdirSync(inner);
  assert.strictEqual(githubStatus(inner).isRepo, false);
});

test('Only real GitHub repository links are accepted', () => {
  assert.deepStrictEqual(parseGitHubUrl('https://github.com/rosa/bakery-site'), { owner: 'rosa', repo: 'bakery-site', webUrl: 'https://github.com/rosa/bakery-site' });
  assert.strictEqual(parseGitHubUrl('https://github.com/rosa/bakery-site.git/')?.repo, 'bakery-site');
  for (const bad of ['http://github.com/rosa/x', 'https://gitlab.com/rosa/x', 'https://github.com/rosa', 'https://github.com/rosa/x/tree/main', 'https://github.com.evil.io/rosa/x', 'github.com/rosa/x']) {
    assert.strictEqual(parseGitHubUrl(bad), null, bad);
  }
});

test('Upload errors become plain-language next steps', () => {
  assert.match(explainPushError('fatal: Authentication failed for https://github.com/x/y.git'), /sign in/i);
  assert.match(explainPushError('remote: Repository not found.'), /can’t find that repository/);
  assert.match(explainPushError('! [rejected] main -> main (fetch first)'), /untick “Add a README”/);
});
