import * as fs from 'fs';
import * as path from 'path';
import { snapshotFiles } from './change-tracker.js';

const TEXT_EXT = new Set([
  '.html', '.htm', '.css', '.scss', '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.json', '.md', '.txt', '.py',
  '.rb', '.go', '.rs', '.java', '.kt', '.cs', '.php', '.vue', '.svelte', '.yml', '.yaml', '.toml', '.xml', '.svg', '.sql', '.sh', '.ps1'
]);
const SKIP_FILES = new Set(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']);
const MAX_FILE_CHARS = 8_000;
const MAX_LISTED = 200;

/**
 * A read-only picture of the project for chat-only models (Ollama) that can't open files
 * themselves: the file list plus the contents of small text files, within a character budget.
 * Secrets-looking files (.env, keys) are never included.
 */
export function buildProjectContext(root: string, budgetChars = 24_000): string {
  const files = [...snapshotFiles(root).keys()].sort();
  if (files.length === 0) return '[Project files]\n(The project folder is empty.)';

  const lines = [`[Project files] (${files.length} total${files.length > MAX_LISTED ? `, first ${MAX_LISTED} shown` : ''})`];
  lines.push(...files.slice(0, MAX_LISTED).map((f) => `- ${f}`));

  let used = lines.join('\n').length;
  const included: string[] = [];
  for (const rel of files) {
    const base = path.basename(rel).toLowerCase();
    if (!TEXT_EXT.has(path.extname(base)) || SKIP_FILES.has(base) || isSecretLooking(base)) continue;
    let content: string;
    try {
      content = fs.readFileSync(path.join(root, rel), 'utf8');
    } catch {
      continue;
    }
    if (content.length > MAX_FILE_CHARS || content.includes('\u0000')) continue;
    const block = `\n--- ${rel} ---\n${content}`;
    if (used + block.length > budgetChars) break;
    included.push(block);
    used += block.length;
  }

  if (included.length) lines.push('\n[File contents]', ...included);
  return lines.join('\n');
}

function isSecretLooking(name: string): boolean {
  return name.startsWith('.env') || /\.(pem|key|p12|pfx)$/.test(name) || /secret|credential|password/.test(name);
}
