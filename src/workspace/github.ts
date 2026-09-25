import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * GitHub for people who don't use git: connect a project to an empty repository they created,
 * and "Save to GitHub" safely. Never force-pushes, never rewrites history, never commits secrets.
 */

export interface GitHubStatus {
  gitInstalled: boolean;
  isRepo: boolean;
  /** https://github.com/owner/repo, when origin points at GitHub. */
  webUrl?: string;
  branch?: string;
  hasUpstream: boolean;
  /** Files a save would include. */
  unsaved: string[];
  /** Files a save will never include (secret-looking or too large). */
  skipped: string[];
  /** Saved locally but not yet uploaded. */
  ahead: number;
  inSync: boolean;
}

export interface SaveResult {
  ok: boolean;
  committed: boolean;
  pushed: boolean;
  /** Plain-language problem and what to do. */
  error?: string;
}

const GITHUB_URL = /^https:\/\/github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/;
const SECRET_FILE = /(^|\/)(\.env(\..*)?|.*\.(pem|key|p12|pfx)|id_rsa.*|.*secret.*|.*credential.*|.*password.*)$/i;
const MAX_FILE_BYTES = 50_000_000;
const IGNORE_LINES = ['.agentmesh/', '.env', '.env.*'];

function git(root: string, args: string[], timeoutMs = 30_000) {
  const res = cp.spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    timeout: timeoutMs,
    // Never block on a terminal prompt; Git Credential Manager shows its own sign-in window instead.
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  });
  return {
    ok: res.status === 0,
    out: (res.stdout ?? '').trim(),
    /** Untrimmed: porcelain status lines start with a meaningful space (" M file"). */
    raw: res.stdout ?? '',
    err: (res.stderr ?? '').trim() || (res.error?.message ?? '')
  };
}

export function parseGitHubUrl(url: string): { owner: string; repo: string; webUrl: string } | null {
  const m = url.trim().match(GITHUB_URL);
  if (!m) return null;
  const repo = m[2].replace(/\.git$/, '');
  return { owner: m[1], repo, webUrl: `https://github.com/${m[1]}/${repo}` };
}

export function githubStatus(root: string): GitHubStatus {
  const base: GitHubStatus = { gitInstalled: false, isRepo: false, hasUpstream: false, unsaved: [], skipped: [], ahead: 0, inSync: false };
  if (!git(root, ['--version']).ok) return base;
  base.gitInstalled = true;
  if (!isOwnRepo(root)) return base;
  base.isRepo = true;

  const origin = git(root, ['remote', 'get-url', 'origin']);
  if (origin.ok) base.webUrl = parseGitHubUrl(origin.out.replace(/^git@github\.com:/, 'https://github.com/'))?.webUrl;
  base.branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).out || undefined;
  const upstream = git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  base.hasUpstream = upstream.ok;
  if (upstream.ok) base.ahead = Number(git(root, ['rev-list', '--count', '@{u}..HEAD']).out) || 0;
  else base.ahead = Number(git(root, ['rev-list', '--count', 'HEAD']).out) || 0;

  const { include, skip } = changedFiles(root);
  base.unsaved = include;
  base.skipped = skip;
  base.inSync = base.hasUpstream && base.ahead === 0 && include.length === 0;
  return base;
}

/** Tracked changes plus new files that aren't ignored, split into "will save" and "never saved". */
function changedFiles(root: string): { include: string[]; skip: string[] } {
  const include: string[] = [];
  const skip: string[] = [];
  const porcelain = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).raw;
  for (const entry of porcelain.split('\0').filter(Boolean)) {
    const code = entry.slice(0, 2);
    const file = entry.slice(3);
    if (code.startsWith('R')) continue; // rename source path follows as its own entry
    const untracked = code === '??';
    let tooBig = false;
    try {
      tooBig = untracked && fs.statSync(path.join(root, file)).size > MAX_FILE_BYTES;
    } catch {
      // deleted file: fine
    }
    if (untracked && (SECRET_FILE.test(file) || tooBig)) skip.push(file);
    else include.push(file);
  }
  return { include, skip };
}

function ensureIgnores(root: string): void {
  const file = path.join(root, '.gitignore');
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const have = new Set(current.split(/\r?\n/).map((l) => l.trim()));
  const missing = IGNORE_LINES.filter((l) => !have.has(l));
  if (missing.length === 0) return;
  const prefix = current && !current.endsWith('\n') ? '\n' : '';
  fs.writeFileSync(file, `${current}${prefix}# Added by AgentMesh: never upload these\n${missing.join('\n')}\n`);
}

const NO_GIT = 'Git isn’t installed. Install Git for Windows from https://git-scm.com/downloads/win (default options), then try again.';

/** "Save to GitHub": commits what changed (never secrets) and uploads it. */
export function saveToGitHub(root: string, message?: string): SaveResult {
  const status = githubStatus(root);
  if (!status.gitInstalled) return { ok: false, committed: false, pushed: false, error: NO_GIT };
  if (!status.isRepo || !status.webUrl) return { ok: false, committed: false, pushed: false, error: 'This project isn’t connected to GitHub yet. Use “Put on GitHub” first.' };
  return commitAndPush(root, parseGitHubUrl(status.webUrl)!.owner, message);
}

/** Identity: the person's own git identity if they have one, else their GitHub username's no-reply address. */
function commitAndPush(root: string, owner: string, message?: string): SaveResult {
  const hasUpstream = git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).ok;
  ensureIgnores(root);
  const { include } = changedFiles(root);
  let committed = false;
  if (include.length) {
    const add = git(root, ['add', '--all', '--', ...include]);
    if (!add.ok) return { ok: false, committed, pushed: false, error: `Couldn’t prepare the files: ${add.err.split('\n')[0]}` };
    const identity = git(root, ['config', 'user.email']).ok ? [] : ['-c', `user.name=${owner}`, '-c', `user.email=${owner}@users.noreply.github.com`];
    const msg = message?.trim() || `Update from AgentMesh (${new Date().toISOString().slice(0, 16).replace('T', ' ')})`;
    const commit = git(root, [...identity, 'commit', '-m', msg]);
    if (!commit.ok) return { ok: false, committed, pushed: false, error: `Couldn’t save the changes: ${commit.err.split('\n')[0]}` };
    committed = true;
  }
  // A first-time push may open GitHub's sign-in window; allow time for the person to sign in.
  const push = git(root, ['push', ...(hasUpstream ? [] : ['-u', 'origin', 'HEAD'])], 180_000);
  if (!push.ok) return { ok: false, committed, pushed: false, error: explainPushError(push.err) };
  return { ok: true, committed, pushed: true };
}

export function explainPushError(err: string): string {
  if (/authentication failed|could not read username|terminal prompts disabled|403|permission to .* denied/i.test(err)) {
    return 'GitHub needs you to sign in. A GitHub sign-in window should have opened; sign in there and click Save again. If no window appeared, reinstall Git for Windows (it includes the sign-in helper).';
  }
  if (/repository not found|does not appear to be a git repository/i.test(err)) {
    return 'GitHub can’t find that repository, or your account can’t access it. Check the link, and that you’re signed in to the account that owns it.';
  }
  if (/rejected|fetch first|non-fast-forward/i.test(err)) {
    return 'The GitHub repository already has content AgentMesh doesn’t have (often a README created on GitHub). For a new project, create the repository empty (untick “Add a README”) and connect again.';
  }
  if (/could not resolve host|network|timed out/i.test(err)) return 'Couldn’t reach GitHub. Check your internet connection and try again.';
  return `Upload failed: ${err.split('\n').find((l) => l.trim()) ?? 'unknown error'}`;
}

/** Connects a project to an (empty) GitHub repository the person created, then saves everything. */
export function connectGitHub(root: string, url: string): SaveResult & { webUrl?: string } {
  const parsed = parseGitHubUrl(url);
  if (!parsed) return { ok: false, committed: false, pushed: false, error: 'That doesn’t look like a GitHub repository link. It should look like https://github.com/your-name/your-project' };
  return { ...attachRemote(root, `${parsed.webUrl}.git`, parsed.owner), webUrl: parsed.webUrl };
}

/** Separated from connectGitHub so tests can use a local bare repository as the remote. */
export function attachRemote(root: string, remote: string, owner: string): SaveResult {
  if (!git(root, ['--version']).ok) return { ok: false, committed: false, pushed: false, error: NO_GIT };
  if (!isOwnRepo(root)) {
    const init = git(root, ['init', '-b', 'main']);
    if (!init.ok) return { ok: false, committed: false, pushed: false, error: `Couldn’t set up version history here: ${init.err}` };
  }
  const existing = git(root, ['remote', 'get-url', 'origin']);
  if (existing.ok && existing.out !== remote) {
    return { ok: false, committed: false, pushed: false, error: `This project is already connected to ${existing.out}. AgentMesh won’t change that.` };
  }
  if (!existing.ok) git(root, ['remote', 'add', 'origin', remote]);
  return commitAndPush(root, owner, 'First save from AgentMesh');
}

/** True only when this folder is itself the top of a repository, not a folder inside some other repo. */
function isOwnRepo(root: string): boolean {
  const top = git(root, ['rev-parse', '--show-toplevel']);
  return top.ok && path.resolve(top.out).toLowerCase() === path.resolve(root).toLowerCase();
}
