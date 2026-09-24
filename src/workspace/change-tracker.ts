import * as fs from 'fs';
import * as path from 'path';

const IGNORED_DIRS = new Set(['.git', 'node_modules', '.agentmesh', 'dist', 'build', '.next', '.venv', 'venv', '__pycache__', 'target']);
const MAX_FILES = 20_000;

export type FileSnapshot = Map<string, number>;

/** Records mtime + size of every file so we can tell which ones an agent touched. Works with or without git. */
export function snapshotFiles(root: string): FileSnapshot {
  const snap: FileSnapshot = new Map();
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (snap.size >= MAX_FILES) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!IGNORED_DIRS.has(e.name)) walk(full);
      } else if (e.isFile()) {
        try {
          const st = fs.statSync(full);
          snap.set(path.relative(root, full).split(path.sep).join('/'), st.mtimeMs * 1e6 + st.size);
        } catch {}
      }
    }
  };
  walk(root);
  return snap;
}

export function diffSnapshots(before: FileSnapshot, after: FileSnapshot): string[] {
  const changed: string[] = [];
  for (const [file, sig] of after) {
    if (before.get(file) !== sig) changed.push(file);
  }
  for (const file of before.keys()) {
    if (!after.has(file)) changed.push(`${file} (deleted)`);
  }
  return changed.sort();
}
