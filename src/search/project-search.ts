import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';
import { snapshotFiles } from '../workspace/change-tracker.js';
import { TaskStore } from '../state/task-store.js';
import { BatonStore } from '../baton/baton-store.js';

const require = createRequire(import.meta.url);

export interface SearchHit {
  kind: 'note' | 'step' | 'file';
  title: string;
  snippet: string;
  /** Full text for the preview pane (capped). */
  text: string;
  at?: number;
  path?: string;
  taskId?: string;
}

const TEXT_EXT = /\.(md|txt|html?|css|scss|js|jsx|mjs|cjs|ts|tsx|json|py|rb|go|rs|java|kt|cs|php|vue|svelte|ya?ml|toml|xml|svg|sql|sh|ps1|csv)$/i;
const SECRET = /^\.env|\.(pem|key|p12|pfx)$|secret|credential|password/i;
const LOCKFILE = /^(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/;
const MAX_FILE_BYTES = 300_000;
const MAX_FILES = 3_000;
const PREVIEW_CHARS = 6_000;

/** The slice of node:sqlite's DatabaseSync used here (the module is loaded at runtime). */
interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): { run(...args: unknown[]): unknown; all(...args: unknown[]): unknown[] };
  close(): void;
}

interface Doc {
  kind: SearchHit['kind'];
  title: string;
  body: string;
  at?: number;
  path?: string;
  taskId?: string;
}

/**
 * Full-text search over everything AgentMesh knows about a project: handoff notes from the AI
 * websites, every agent step (instruction + result), and the project's own text files.
 * Uses the SQLite FTS5 engine built into Node, so there's nothing to install. The index lives in
 * memory and is rebuilt only when something changed.
 */
export class ProjectSearch {
  private db: SqliteDb | null = null;
  private signature = '';
  private docs: Doc[] = [];

  constructor(private root: string) {}

  search(query: string, limit = 30): SearchHit[] {
    const match = toFtsQuery(query);
    if (!match) return [];
    const db = this.ensureIndex();
    const run = (q: string) =>
      db
        .prepare(
          `SELECT rowid, snippet(docs, 1, '⟦', '⟧', '…', 14) AS snip FROM docs WHERE docs MATCH ? ORDER BY rank LIMIT ?`
        )
        .all(q, limit) as { rowid: number; snip: string }[];
    let rows = run(match.all);
    if (rows.length === 0 && match.any !== match.all) rows = run(match.any);
    return rows.map((r) => {
      const d = this.docs[r.rowid - 1];
      return { kind: d.kind, title: d.title, snippet: r.snip, text: d.body.slice(0, PREVIEW_CHARS), at: d.at, path: d.path, taskId: d.taskId };
    });
  }

  private ensureIndex(): SqliteDb {
    const files = snapshotFiles(this.root);
    const stamp = (p: string) => {
      try {
        return fs.statSync(p).mtimeMs;
      } catch {
        return 0;
      }
    };
    const sig = [
      [...files.entries()].map(([f, s]) => `${f}:${s}`).join('|'),
      stamp(path.join(this.root, '.agentmesh', 'baton.json')),
      stamp(path.join(this.root, '.agentmesh', 'tasks'))
    ].join('#');
    if (this.db && sig === this.signature) return this.db;

    const docs: Doc[] = [];
    const baton = new BatonStore(this.root).get();
    baton.briefs.forEach((b, i) => {
      docs.push({ kind: 'note', title: `Handoff note ${i + 1} from ${b.from}${b.project ? ` · ${b.project}` : ''}`, body: b.text, at: b.at });
    });
    for (const t of new TaskStore(this.root).listTasks()) {
      for (const r of t.runs ?? []) {
        const files = r.filesChanged.length ? `\nFiles changed: ${r.filesChanged.join(', ')}` : '';
        docs.push({
          kind: 'step',
          title: `${r.instruction.slice(0, 90)}${r.agent ? ` (${r.agent})` : ''}`,
          body: `${r.instruction}\n\n${r.output || r.error || ''}${files}`,
          at: r.startedAt,
          taskId: t.taskId
        });
      }
    }
    let count = 0;
    for (const rel of files.keys()) {
      if (count >= MAX_FILES) break;
      const base = path.posix.basename(rel);
      if (!TEXT_EXT.test(base) || SECRET.test(base) || LOCKFILE.test(base)) continue;
      const full = path.join(this.root, rel);
      try {
        if (fs.statSync(full).size > MAX_FILE_BYTES) continue;
        const body = fs.readFileSync(full, 'utf8');
        if (body.includes('\u0000')) continue;
        docs.push({ kind: 'file', title: rel, body, path: rel });
        count++;
      } catch {
        // unreadable: skip
      }
    }

    const { DatabaseSync } = require('node:sqlite');
    this.db?.close();
    const db = new DatabaseSync(':memory:') as SqliteDb;
    db.exec(`CREATE VIRTUAL TABLE docs USING fts5(title, body, tokenize = 'unicode61 remove_diacritics 2')`);
    const insert = db.prepare('INSERT INTO docs(rowid, title, body) VALUES (?, ?, ?)');
    docs.forEach((d, i) => insert.run(i + 1, d.title, d.body));
    this.db = db;
    this.docs = docs;
    this.signature = sig;
    return db;
  }
}

/** Turns what a person types into a safe FTS5 query: every word as a prefix term, all required first, any as fallback. */
export function toFtsQuery(input: string): { all: string; any: string } | null {
  const words = (input.toLowerCase().match(/[\p{L}\p{N}@._-]+/gu) ?? [])
    .map((w) => w.replace(/^[._-]+|[._-]+$/g, ''))
    .filter((w) => w.length > 1)
    .slice(0, 12);
  if (words.length === 0) return null;
  const terms = words.map((w) => `"${w.replace(/"/g, '')}"*`);
  return { all: terms.join(' '), any: terms.join(' OR ') };
}
