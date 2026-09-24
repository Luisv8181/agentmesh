import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { snapshotFiles } from '../workspace/change-tracker.js';
import { TaskStore } from '../state/task-store.js';
import { WebSite, WEB_SITES, SITE_INFO, parseBrief, buildContinueMessage } from './protocol.js';

export interface Brief {
  id: string;
  from: WebSite | 'agentmesh';
  at: number;
  text: string;
  project?: string;
  keyFiles: string[];
  wellFormed: boolean;
}

export interface SiteLedger {
  protocolInstalled: boolean;
  lastPassAt?: number;
  /** The newest brief this site has been given. */
  briefId?: string;
  /** Files handed to this site: relative path → content hash at the time. */
  files: Record<string, string>;
}

interface BatonData {
  briefs: Brief[];
  sites: Record<WebSite, SiteLedger>;
}

export interface FileSuggestion {
  path: string;
  reason: string;
}

const MAX_HASH_BYTES = 2_000_000;

/**
 * Per-project record of the web-chat relay: every brief, and what each AI website has been given.
 * This ledger is the source of truth for "what does Claude know about the project"; the sites' own
 * memory is a bonus and can be stale.
 */
export class BatonStore {
  private file: string;

  constructor(private workspaceRoot: string) {
    this.file = path.join(workspaceRoot, '.agentmesh', 'baton.json');
  }

  private load(): BatonData {
    const empty: BatonData = {
      briefs: [],
      sites: Object.fromEntries(WEB_SITES.map((s) => [s, { protocolInstalled: false, files: {} }])) as Record<WebSite, SiteLedger>
    };
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<BatonData>;
      return {
        briefs: Array.isArray(data.briefs) ? data.briefs : [],
        sites: Object.fromEntries(WEB_SITES.map((s) => [s, { ...empty.sites[s], ...(data.sites?.[s] ?? {}) }])) as Record<WebSite, SiteLedger>
      };
    } catch {
      return empty;
    }
  }

  private save(data: BatonData): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(data, null, 2), 'utf8');
  }

  get(): BatonData {
    return this.load();
  }

  latestBrief(): Brief | undefined {
    return this.load().briefs.at(-1);
  }

  addBrief(from: Brief['from'], raw: string): Brief {
    const parsed = parseBrief(raw);
    if (!parsed.text) throw new Error('The brief is empty. Paste the reply you got after typing "mesh wrap".');
    const data = this.load();
    const brief: Brief = { id: `brief-${uuidv4().slice(0, 8)}`, from, at: Date.now(), ...parsed };
    data.briefs.push(brief);
    // The site that wrote the brief knows it, and has the key files it names ("files I shared or you made").
    if (from !== 'agentmesh') {
      const ledger = data.sites[from];
      ledger.briefId = brief.id;
      ledger.lastPassAt = brief.at;
      const projectFiles = [...snapshotFiles(this.workspaceRoot).keys()];
      for (const name of brief.keyFiles) {
        const match = this.matchProjectFile(name, projectFiles);
        const h = match && this.hashFile(match);
        if (match && h) ledger.files[match] = h;
      }
    }
    this.save(data);
    return brief;
  }

  setProtocolInstalled(site: WebSite, installed: boolean): void {
    const data = this.load();
    data.sites[site].protocolInstalled = installed;
    this.save(data);
  }

  /** Records that the person handed the latest brief (and these files) to a site. */
  recordPass(to: WebSite, files: string[]): void {
    const data = this.load();
    const ledger = data.sites[to];
    ledger.lastPassAt = Date.now();
    ledger.briefId = data.briefs.at(-1)?.id ?? ledger.briefId;
    for (const f of files) {
      const h = this.hashFile(f);
      if (h) ledger.files[f] = h;
    }
    this.save(data);
  }

  /**
   * Files worth uploading to `to` now: ones the latest brief names, ones changed since that site last
   * got them, and ones coding agents changed since that site was last updated.
   */
  suggestFiles(to: WebSite): FileSuggestion[] {
    const data = this.load();
    const ledger = data.sites[to];
    const brief = data.briefs.at(-1);
    const projectFiles = [...snapshotFiles(this.workspaceRoot).keys()];
    const out = new Map<string, string>();

    for (const name of brief?.keyFiles ?? []) {
      const match = this.matchProjectFile(name, projectFiles);
      if (match && ledger.files[match] !== this.hashFile(match)) {
        out.set(match, ledger.files[match] ? `changed since ${SITE_INFO[to].name} last saw it` : 'named in the latest brief');
      }
    }
    for (const [f, h] of Object.entries(ledger.files)) {
      if (!projectFiles.includes(f)) continue;
      if (this.hashFile(f) !== h && !out.has(f)) out.set(f, `changed since ${SITE_INFO[to].name} last saw it`);
    }
    const since = ledger.lastPassAt ?? 0;
    for (const run of new TaskStore(this.workspaceRoot).listTasks().flatMap((t) => t.runs ?? [])) {
      if (run.startedAt < since || !run.success) continue;
      for (const f of run.filesChanged) {
        if (projectFiles.includes(f) && !out.has(f) && ledger.files[f] !== this.hashFile(f)) out.set(f, `changed by ${run.agent ?? 'a coding agent'}`);
      }
    }
    return [...out].map(([p, reason]) => ({ path: p, reason }));
  }

  /** Everything the person needs to continue on `to`: the message to paste and the files to attach. */
  continueOn(to: WebSite): { message: string; files: FileSuggestion[] } {
    const data = this.load();
    const brief = data.briefs.at(-1);
    const files = this.suggestFiles(to);
    const since = brief?.at ?? 0;
    const agentWork = new TaskStore(this.workspaceRoot)
      .listTasks()
      .flatMap((t) => t.runs ?? [])
      .filter((r) => r.success && r.startedAt > since)
      .sort((a, b) => a.startedAt - b.startedAt)
      .slice(-5)
      .map((r) => ({ instruction: r.instruction, agent: r.agent, summary: r.output, files: r.filesChanged }));

    const message = buildContinueMessage({
      to,
      projectName: brief?.project || path.basename(this.workspaceRoot),
      brief: brief && { text: brief.text, from: brief.from === 'agentmesh' ? 'AgentMesh' : SITE_INFO[brief.from].name, at: brief.at },
      agentWork,
      attachments: files.map((f) => path.basename(f.path))
    });
    return { message, files };
  }

  /** What each site knows, in plain language. */
  knowledge(): Record<WebSite, { protocolInstalled: boolean; upToDate: boolean; summary: string }> {
    const data = this.load();
    const latest = data.briefs.at(-1);
    const result = {} as Record<WebSite, { protocolInstalled: boolean; upToDate: boolean; summary: string }>;
    for (const s of WEB_SITES) {
      const l = data.sites[s];
      const n = l.briefId ? data.briefs.findIndex((b) => b.id === l.briefId) + 1 : 0;
      const upToDate = !latest || l.briefId === latest.id;
      const summary = !l.lastPassAt
        ? 'Hasn’t seen this project yet.'
        : `Has brief ${n} of ${data.briefs.length}${Object.keys(l.files).length ? ` and ${Object.keys(l.files).length} file(s)` : ''}, last updated ${new Date(l.lastPassAt).toLocaleDateString()}.${upToDate ? '' : ' Behind the latest brief.'}`;
      result[s] = { protocolInstalled: l.protocolInstalled, upToDate, summary };
    }
    return result;
  }

  private matchProjectFile(name: string, projectFiles: string[]): string | undefined {
    const norm = name.replace(/\\/g, '/').replace(/^\.\//, '');
    return projectFiles.find((f) => f === norm) ?? projectFiles.find((f) => path.posix.basename(f).toLowerCase() === path.posix.basename(norm).toLowerCase());
  }

  private hashFile(rel: string): string | undefined {
    try {
      const full = path.join(this.workspaceRoot, rel);
      if (fs.statSync(full).size > MAX_HASH_BYTES) return `size:${fs.statSync(full).size}:${fs.statSync(full).mtimeMs}`;
      return crypto.createHash('sha1').update(fs.readFileSync(full)).digest('hex');
    } catch {
      return undefined;
    }
  }
}
