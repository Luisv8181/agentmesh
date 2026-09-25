import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentId } from '../types.js';

export const ALL_AGENTS: AgentId[] = ['claude', 'codex', 'agy', 'copilot', 'gemini', 'opencode', 'ollama'];

export type Mode = 'subscriptions' | 'free';

/**
 * Defaults each mode applies when chosen. Subscriptions: coding agents first, failover between paid plans.
 * Free: free helpers only, and smart routing on so free quotas last.
 */
export const MODE_PRESETS: Record<Mode, Pick<AgentMeshConfig, 'priority' | 'smartRouting'>> = {
  subscriptions: { priority: ['claude', 'codex', 'copilot', 'agy', 'gemini', 'opencode', 'ollama'], smartRouting: false },
  free: { priority: ['agy', 'copilot', 'gemini', 'opencode', 'ollama'], smartRouting: true }
};

export interface AgentMeshConfig {
  /** How the person uses AI; null until they choose on the welcome screen. */
  mode: Mode | null;
  /** Order agents are tried in. Agents not listed are never used. */
  priority: AgentId[];
  /** Commit tracked, modified files to git when one agent hands off to another. */
  autoCommit: boolean;
  /** 'edit' lets agents change files in the project; 'readonly' only lets them read and answer. */
  permission: 'edit' | 'readonly';
  ollamaModel: string;
  /** Per-agent model override passed as --model; empty means the CLI's own default. */
  models: Partial<Record<AgentId, string>>;
  /** Send questions to Ollama first (read-only) and never send edits to Ollama. */
  smartRouting: boolean;
  recentWorkspaces: string[];
  onboarded: boolean;
}

export const DEFAULT_CONFIG: AgentMeshConfig = {
  mode: null,
  priority: [...ALL_AGENTS],
  autoCommit: false,
  permission: 'edit',
  ollamaModel: process.env.OLLAMA_MODEL || 'qwen2.5:7b',
  models: {},
  smartRouting: false,
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

  /** Switches mode and applies its defaults (agent order, smart routing). */
  setMode(mode: Mode): AgentMeshConfig {
    return this.update({ mode, ...MODE_PRESETS[mode], priority: [...MODE_PRESETS[mode].priority] });
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
    mode: c.mode === 'subscriptions' || c.mode === 'free' ? c.mode : null,
    priority,
    autoCommit: c.autoCommit === true,
    permission: c.permission === 'readonly' ? 'readonly' : 'edit',
    ollamaModel: typeof c.ollamaModel === 'string' && c.ollamaModel.trim() ? c.ollamaModel.trim() : DEFAULT_CONFIG.ollamaModel,
    models: Object.fromEntries(
      Object.entries(c.models && typeof c.models === 'object' ? c.models : {})
        .filter(([id, m]) => ALL_AGENTS.includes(id as AgentId) && id !== 'ollama' && typeof m === 'string' && /^\w[\w.:\/\[\]-]{0,99}$/.test(m.trim()))
        .map(([id, m]) => [id, (m as string).trim()])
    ),
    smartRouting: c.smartRouting === true,
    recentWorkspaces: Array.isArray(c.recentWorkspaces) ? c.recentWorkspaces.filter((d) => typeof d === 'string') : [],
    onboarded: c.onboarded === true
  };
}
