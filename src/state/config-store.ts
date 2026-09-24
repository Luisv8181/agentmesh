import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentId } from '../types.js';

export const ALL_AGENTS: AgentId[] = ['claude', 'codex', 'agy', 'gemini', 'opencode', 'ollama'];

export interface AgentMeshConfig {
  /** Order agents are tried in. Agents not listed are never used. */
  priority: AgentId[];
  /** Commit tracked, modified files to git when one agent hands off to another. */
  autoCommit: boolean;
  /** 'edit' lets agents change files in the project; 'readonly' only lets them read and answer. */
  permission: 'edit' | 'readonly';
  ollamaModel: string;
  /** Per-agent model override passed as --model; empty means the CLI's own default. */
  models: Partial<Record<AgentId, string>>;
  recentWorkspaces: string[];
  onboarded: boolean;
}

export const DEFAULT_CONFIG: AgentMeshConfig = {
  priority: [...ALL_AGENTS],
  autoCommit: false,
  permission: 'edit',
  ollamaModel: process.env.OLLAMA_MODEL || 'qwen2.5:7b',
  models: {},
  recentWorkspaces: [],
  onboarded: false
};

/** User-level state lives in ~/.agentmesh (override with AGENTMESH_HOME). Rate limits are per account, not per project. */
export function agentMeshHome(): string {
  return process.env.AGENTMESH_HOME || path.join(os.homedir(), '.agentmesh');
}

export class ConfigStore {
  private filePath: string;
  private config: AgentMeshConfig;

  constructor(home = agentMeshHome()) {
    fs.mkdirSync(home, { recursive: true });
    this.filePath = path.join(home, 'config.json');
    this.config = this.load();
  }

  private load(): AgentMeshConfig {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      return sanitize({ ...DEFAULT_CONFIG, ...raw });
    } catch {
      return { ...DEFAULT_CONFIG, priority: [...DEFAULT_CONFIG.priority] };
    }
  }

  get(): AgentMeshConfig {
    return { ...this.config, priority: [...this.config.priority], models: { ...this.config.models }, recentWorkspaces: [...this.config.recentWorkspaces] };
  }

  update(patch: Partial<AgentMeshConfig>): AgentMeshConfig {
    this.config = sanitize({ ...this.config, ...patch });
    fs.writeFileSync(this.filePath, JSON.stringify(this.config, null, 2), 'utf8');
    return this.get();
  }

  rememberWorkspace(dir: string): void {
    const recent = [dir, ...this.config.recentWorkspaces.filter((d) => d !== dir)].slice(0, 8);
    this.update({ recentWorkspaces: recent });
  }
}

function sanitize(c: AgentMeshConfig): AgentMeshConfig {
  const priority = Array.isArray(c.priority)
    ? c.priority.filter((a, i, arr): a is AgentId => ALL_AGENTS.includes(a) && arr.indexOf(a) === i)
    : [...ALL_AGENTS];
  return {
    priority,
    autoCommit: c.autoCommit === true,
    permission: c.permission === 'readonly' ? 'readonly' : 'edit',
    ollamaModel: typeof c.ollamaModel === 'string' && c.ollamaModel.trim() ? c.ollamaModel.trim() : DEFAULT_CONFIG.ollamaModel,
    models: Object.fromEntries(
      Object.entries(c.models && typeof c.models === 'object' ? c.models : {})
        .filter(([id, m]) => ALL_AGENTS.includes(id as AgentId) && id !== 'ollama' && typeof m === 'string' && /^\w[\w.:\/\[\]-]{0,99}$/.test(m.trim()))
        .map(([id, m]) => [id, (m as string).trim()])
    ),
    recentWorkspaces: Array.isArray(c.recentWorkspaces) ? c.recentWorkspaces.filter((d) => typeof d === 'string') : [],
    onboarded: c.onboarded === true
  };
}
