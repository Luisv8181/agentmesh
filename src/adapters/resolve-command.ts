import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface ResolvedCommand {
  file: string;
  prefixArgs: string[];
}

const cache = new Map<string, ResolvedCommand | null>();

/**
 * Finds the real executable behind a CLI name so it can be spawned without a shell.
 *
 * On Windows, npm installs CLIs as `.cmd` shims. Running those means going through
 * cmd.exe, which treats `&`, `|`, `>` etc. in the prompt as shell syntax and cuts the
 * command line at the first newline. Instead we read the shim, find the `.exe` or `.js`
 * it launches, and spawn that directly so the prompt arrives byte-for-byte.
 */
export function resolveCommand(name: string): ResolvedCommand | null {
  if (cache.has(name)) return cache.get(name)!;
  const resolved = process.platform === 'win32' ? resolveWindows(name) : resolvePosix(name);
  cache.set(name, resolved);
  return resolved;
}

export function clearResolveCache(): void {
  cache.clear();
}

/**
 * Installers add their folder to the user/machine PATH in the registry, but a running
 * process keeps the PATH it started with. Merge in the current registry values so a CLI
 * installed while AgentMesh is open is found without restarting.
 */
export function refreshPathFromSystem(): void {
  if (process.platform !== 'win32') return;
  const reg = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
  const readPath = (key: string): string => {
    const res = cp.spawnSync(reg, ['query', key, '/v', 'Path'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
    return res.stdout?.match(/^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/im)?.[1] ?? '';
  };
  const fromRegistry = [
    readPath('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'),
    readPath('HKCU\\Environment')
  ].join(';');

  const current = (process.env.PATH || '').split(';').filter(Boolean);
  const known = new Set(current.map((p) => p.toLowerCase()));
  const expand = (p: string) => p.replace(/%([^%]+)%/g, (m, v: string) => process.env[v] ?? m);
  for (const entry of fromRegistry.split(';').map((p) => expand(p.trim())).filter(Boolean)) {
    if (!known.has(entry.toLowerCase())) {
      current.push(entry);
      known.add(entry.toLowerCase());
    }
  }
  process.env.PATH = current.join(';');
}

function resolvePosix(name: string): ResolvedCommand | null {
  const res = cp.spawnSync('which', [name], { encoding: 'utf8' });
  const found = res.status === 0 ? res.stdout.trim().split('\n')[0] : '';
  return found ? { file: found, prefixArgs: [] } : null;
}

function resolveWindows(name: string): ResolvedCommand | null {
  const where = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'where.exe');
  const res = cp.spawnSync(where, [name], { encoding: 'utf8', windowsHide: true });
  if (res.status !== 0 || !res.stdout) return null;

  const candidates = res.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  for (const candidate of candidates) {
    const ext = path.extname(candidate).toLowerCase();
    if (ext === '.exe') return { file: candidate, prefixArgs: [] };
    if (ext === '.cmd' || ext === '.bat') {
      const target = parseShim(candidate);
      if (target) return target;
    }
  }
  return null;
}

export function parseShim(shimPath: string): ResolvedCommand | null {
  let content: string;
  try {
    content = fs.readFileSync(shimPath, 'utf8');
  } catch {
    return null;
  }

  const shimDir = path.dirname(shimPath);
  const expand = (s: string) =>
    s
      .replace(/%~?dp0%?\\?/gi, shimDir + path.sep)
      .replace(/%([A-Z_][A-Z0-9_]*)%/gi, (m, v: string) => process.env[v] ?? m);

  const quoted = [...content.matchAll(/"([^"\r\n]+\.(?:exe|js|cjs|mjs))"/gi)].map((m) => m[1]);
  // The launch line comes last in npm shims; earlier matches are `IF EXIST node.exe` checks.
  for (const raw of quoted.reverse()) {
    const target = path.normalize(expand(raw));
    if (!fs.existsSync(target)) continue;
    if (/\.exe$/i.test(target)) {
      if (/[\\/]node\.exe$/i.test(target)) continue;
      return { file: target, prefixArgs: [] };
    }
    return { file: process.execPath, prefixArgs: [target] };
  }
  return null;
}
