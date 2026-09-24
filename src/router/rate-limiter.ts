import * as fs from 'fs';
import * as path from 'path';
import { AgentId } from '../types.js';

interface RateLimitState {
  cooldownUntil: number | null;
  consecutiveErrors: number;
  lastUsed: number | null;
  lastError?: string;
}

const DEFAULT_COOLDOWNS_MS = [
  60 * 1000,         // 1 minute
  5 * 60 * 1000,     // 5 minutes
  25 * 60 * 1000,    // 25 minutes
  60 * 60 * 1000,    // 1 hour
  5 * 60 * 60 * 1000 // 5 hours (billing/hard cap)
];

const RATE_LIMIT_REGEXES = [
  /rate\s*limit/i,
  /too\s*many\s*requests/i,
  /\b429\b/,
  /quota\s*exceeded/i,
  /usage\s*limit/i,
  /insufficient\s*credits/i,
  /credit\s*balance/i,
  /capacity\s*exceeded/i,
  /model\s*is\s*currently\s*overloaded/i,
  /please\s*try\s*again\s*in/i,
  /resets\s*(?:in|at)/i
];

import { globalUsageMonitor } from './usage-monitor.js';
import { agentMeshHome } from '../state/config-store.js';

export class RateLimiter {
  private filePath: string;
  private state: Record<string, RateLimitState> = {};

  /** stateDir is user-level (~/.agentmesh): limits belong to the account, not the project. */
  constructor(stateDir = agentMeshHome()) {
    try { fs.mkdirSync(stateDir, { recursive: true }); } catch {}
    this.filePath = path.join(stateDir, 'rate-limits.json');
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        this.state = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      }
    } catch {
      this.state = {};
    }
  }

  private persist(): void {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), 'utf8');
    } catch {}
  }

  /**
   * Some CLIs (Codex) echo the prompt into their error log. Lines that came from the prompt are
   * ignored, or a request like "add rate limiting" would bench the agent on a fake rate limit.
   */
  public isRateLimit(message: string, prompt = ''): boolean {
    if (!message) return false;
    const promptLines = new Set(prompt.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0));
    const own = message.split(/\r?\n/).filter((l) => !promptLines.has(l.trim())).join('\n');
    return RATE_LIMIT_REGEXES.some((rx) => rx.test(own));
  }

  public isAgentInCooldown(agentId: AgentId): boolean {
    const record = this.state[agentId];
    if (!record || !record.cooldownUntil) return false;
    if (Date.now() >= record.cooldownUntil) {
      record.cooldownUntil = null;
      this.persist();
      globalUsageMonitor.resetCooldown(agentId);
      return false;
    }
    return true;
  }

  public getCooldownRemainingSec(agentId: AgentId): number {
    const record = this.state[agentId];
    if (!record || !record.cooldownUntil) return 0;
    const remaining = record.cooldownUntil - Date.now();
    return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
  }

  public recordSuccess(agentId: AgentId): void {
    const record = this.getOrCreate(agentId);
    record.consecutiveErrors = 0;
    record.cooldownUntil = null;
    record.lastUsed = Date.now();
    record.lastError = undefined;
    this.persist();
    globalUsageMonitor.resetCooldown(agentId);
  }

  public recordRateLimit(agentId: AgentId, errorMsg: string): number {
    const record = this.getOrCreate(agentId);
    record.consecutiveErrors += 1;
    record.lastUsed = Date.now();
    record.lastError = errorMsg;

    const tier = Math.min(record.consecutiveErrors - 1, DEFAULT_COOLDOWNS_MS.length - 1);
    const durationMs = DEFAULT_COOLDOWNS_MS[tier];
    record.cooldownUntil = Date.now() + durationMs;
    this.persist();

    globalUsageMonitor.recordRateLimit(agentId, errorMsg, durationMs);
    return durationMs;
  }

  public recordGenericError(agentId: AgentId, errorMsg: string): void {
    const record = this.getOrCreate(agentId);
    record.consecutiveErrors += 1;
    record.lastUsed = Date.now();
    record.lastError = errorMsg;
    // 15-second pause on general failures
    record.cooldownUntil = Date.now() + 15_000;
    this.persist();

    globalUsageMonitor.recordRateLimit(agentId, `Error: ${errorMsg}`, 15_000);
  }

  public resetAgent(agentId: AgentId): void {
    if (this.state[agentId]) {
      this.state[agentId].cooldownUntil = null;
      this.state[agentId].consecutiveErrors = 0;
      this.state[agentId].lastError = undefined;
      this.persist();
    }
    globalUsageMonitor.resetCooldown(agentId);
  }

  public resetAll(): void {
    for (const key of Object.keys(this.state)) {
      this.state[key].cooldownUntil = null;
      this.state[key].consecutiveErrors = 0;
      this.state[key].lastError = undefined;
      globalUsageMonitor.resetCooldown(key as AgentId);
    }
    this.persist();
  }

  public getState(agentId: AgentId): RateLimitState {
    return this.getOrCreate(agentId);
  }

  private getOrCreate(agentId: AgentId): RateLimitState {
    if (!this.state[agentId]) {
      this.state[agentId] = {
        cooldownUntil: null,
        consecutiveErrors: 0,
        lastUsed: null
      };
    }
    return this.state[agentId];
  }
}
