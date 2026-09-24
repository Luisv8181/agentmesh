import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createRequire } from 'module';
import { AgentId } from '../types.js';

const require = createRequire(import.meta.url);

export interface TokenUsageReport {
  estimatedPromptTokens: number;
  estimatedTotalSessionTokens: number;
  claudeLiveStats?: {
    todayTokens: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    cacheReadTokens: number;
  };
  codexLiveStats?: {
    model: string;
    tokensUsedToday: number;
    activeThreads: number;
    latestUpdateMs?: number;
  };
  ollamaLiveStats?: {
    lastPromptTokens: number;
    lastCompletionTokens: number;
  };
}

const STATS_TTL_MS = 60_000;

export class TokenTracker {
  private workspaceRoot: string;
  private sessionTokens: Map<AgentId, number> = new Map();
  private statsCache = new Map<string, { at: number; value: unknown }>();

  private cached<T>(key: string, compute: () => T): T {
    const hit = this.statsCache.get(key);
    if (hit && Date.now() - hit.at < STATS_TTL_MS) return hit.value as T;
    const value = compute();
    this.statsCache.set(key, { at: Date.now(), value });
    return value;
  }

  constructor(workspaceRoot = process.cwd()) {
    this.workspaceRoot = workspaceRoot;
  }

  /**
   * Fast, reliable token estimation based on subword BPE characteristics.
   * Averages 3.7 - 4.0 characters per token for English & code.
   */
  public estimateTokens(text: string): number {
    if (!text) return 0;
    // Account for whitespace/punctuation tokenization density
    const charCount = text.length;
    const wordCount = text.trim().split(/\s+/).length;
    // Blended estimation formula (highly correlated with cl100k and claude tokenizers)
    return Math.max(1, Math.round((charCount * 0.22) + (wordCount * 0.28)));
  }

  /**
   * Ingests real token usage data written by Claude Code CLI from active session logs
   * and ~/.claude/stats-cache.json.
   */
  public readClaudeStats(): TokenUsageReport['claudeLiveStats'] | undefined {
    return this.cached('claude', () => this.readClaudeStatsUncached());
  }

  private readClaudeStatsUncached(): TokenUsageReport['claudeLiveStats'] | undefined {
    const claudeDir = path.join(os.homedir(), '.claude');
    const projectsDir = path.join(claudeDir, 'projects');

    // 1. First, attempt to aggregate live session tokens from today's JSONL logs
    if (fs.existsSync(projectsDir)) {
      try {
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);

        let foundTodayFiles = false;
        // Claude Code logs one line per content block, each repeating the message's usage;
        // the last line for a message carries the final counts.
        type Usage = { input_tokens?: number; cache_creation_input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
        const byMessage = new Map<string, Usage>();
        let anonymous = 0;

        const walk = (dir: string) => {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name.endsWith('.jsonl')) {
              const stat = fs.statSync(full);
              if (stat.mtime >= todayStart) {
                foundTodayFiles = true;
                const content = fs.readFileSync(full, 'utf8');
                const lines = content.split('\n');
                for (const line of lines) {
                  if (!line.trim()) continue;
                  try {
                    const obj = JSON.parse(line);
                    const rawTime = obj.timestamp || obj.message?.timestamp || obj.created_at;
                    if (!rawTime || new Date(rawTime) < todayStart) continue;

                    const usage = obj.message?.usage || obj.usage;
                    if (usage) {
                      byMessage.set(obj.message?.id || `anon-${anonymous++}`, usage);
                    }
                  } catch {}
                }
              }
            }
          }
        };

        walk(projectsDir);

        let liveInput = 0;
        let liveOutput = 0;
        let liveCacheRead = 0;
        for (const u of byMessage.values()) {
          liveInput += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0);
          liveOutput += u.output_tokens || 0;
          liveCacheRead += u.cache_read_input_tokens || 0;
        }

        if (foundTodayFiles && (liveInput > 0 || liveOutput > 0)) {
          return {
            todayTokens: liveInput + liveOutput,
            totalInputTokens: liveInput,
            totalOutputTokens: liveOutput,
            cacheReadTokens: liveCacheRead
          };
        }
      } catch {}
    }

    // 2. Fallback to stats-cache.json
    const claudeStatsPath = path.join(claudeDir, 'stats-cache.json');
    if (!fs.existsSync(claudeStatsPath)) return undefined;

    try {
      const raw = fs.readFileSync(claudeStatsPath, 'utf8');
      const data = JSON.parse(raw);

      let todayTokens = 0;
      const todayStr = new Date().toISOString().slice(0, 10);
      if (Array.isArray(data.dailyModelTokens)) {
        const todayEntry = data.dailyModelTokens.find((d: any) => d.date === todayStr);
        if (todayEntry && todayEntry.tokensByModel) {
          todayTokens = Object.values(todayEntry.tokensByModel).reduce((a: any, b: any) => a + b, 0) as number;
        }
      }

      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let cacheReadTokens = 0;

      if (data.modelUsage) {
        for (const m of Object.values(data.modelUsage) as any[]) {
          totalInputTokens += m.inputTokens || 0;
          totalOutputTokens += m.outputTokens || 0;
          cacheReadTokens += m.cacheReadInputTokens || 0;
        }
      }

      return {
        todayTokens,
        totalInputTokens,
        totalOutputTokens,
        cacheReadTokens
      };
    } catch {
      return undefined;
    }
  }

  /**
   * Ingests real token usage and thread activity from local OpenAI Codex state
   * (~/.codex/state_5.sqlite).
   */
  public readCodexStats(): TokenUsageReport['codexLiveStats'] | undefined {
    return this.cached('codex', () => this.readCodexStatsUncached());
  }

  private readCodexStatsUncached(): TokenUsageReport['codexLiveStats'] | undefined {
    try {
      const codexDb = path.join(os.homedir(), '.codex', 'state_5.sqlite');
      if (!fs.existsSync(codexDb)) return undefined;

      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(codexDb, { readOnly: true });

      const todayStartMs = new Date().setHours(0, 0, 0, 0);
      const stmt = db.prepare('SELECT id, model, tokens_used, updated_at_ms FROM threads WHERE updated_at_ms >= ? ORDER BY updated_at_ms DESC');
      const rows = stmt.all(todayStartMs) as any[];
      db.close();

      if (!rows || rows.length === 0) return undefined;

      let tokensUsedToday = 0;
      for (const r of rows) {
        tokensUsedToday += r.tokens_used || 0;
      }

      return {
        model: rows[0]?.model || 'unknown',
        tokensUsedToday,
        activeThreads: rows.length,
        latestUpdateMs: rows[0]?.updated_at_ms
      };
    } catch {
      return undefined;
    }
  }

  /**
   * Constructs an explicit self-budgeting prompt header that instructs
   * the receiving AI agent how to self-regulate its output and token budget.
   */
  public buildTokenBudgetDirective(agentId: AgentId, prompt: string, maxOutputTokens = 4000): string {
    const estInput = this.estimateTokens(prompt);
    const claudeStats = agentId === 'claude' ? this.readClaudeStats() : undefined;
    const codexStats = agentId === 'codex' ? this.readCodexStats() : undefined;

    let header = `[TOKEN BUDGET & CONTEXT TELEMETRY]\n` +
      `• Estimated Directive Tokens: ~${estInput.toLocaleString()}\n` +
      `• Recommended Max Output: ~${maxOutputTokens.toLocaleString()} tokens\n`;

    if (claudeStats && claudeStats.todayTokens > 0) {
      header += `• Today's Claude Cumulative Tokens: ~${claudeStats.todayTokens.toLocaleString()} tokens\n`;
    }

    if (codexStats && codexStats.tokensUsedToday > 0) {
      header += `• Today's Codex Cumulative Tokens (${codexStats.model}): ~${codexStats.tokensUsedToday.toLocaleString()} tokens\n`;
    }

    header += `• Self-Regulation Rule: Prioritize concise, unified diffs and targeted code snippets. Do not output duplicate boilerplate or conversational filler.\n`;

    return header;
  }

  public recordUsage(agentId: AgentId, tokens: number): void {
    const current = this.sessionTokens.get(agentId) || 0;
    this.sessionTokens.set(agentId, current + tokens);
  }

  public getSessionUsage(agentId: AgentId): number {
    return this.sessionTokens.get(agentId) || 0;
  }
}

export const globalTokenTracker = new TokenTracker();
