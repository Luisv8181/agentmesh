import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { AgentId } from '../types.js';

export interface TokenUsageReport {
  estimatedPromptTokens: number;
  estimatedTotalSessionTokens: number;
  claudeLiveStats?: {
    todayTokens: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    cacheReadTokens: number;
  };
  ollamaLiveStats?: {
    lastPromptTokens: number;
    lastCompletionTokens: number;
  };
}

export class TokenTracker {
  private workspaceRoot: string;
  private sessionTokens: Map<AgentId, number> = new Map();

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
    const claudeDir = path.join(os.homedir(), '.claude');
    const projectsDir = path.join(claudeDir, 'projects');

    // 1. First, attempt to aggregate live session tokens from today's JSONL logs
    if (fs.existsSync(projectsDir)) {
      try {
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);

        let liveInput = 0;
        let liveOutput = 0;
        let liveCacheRead = 0;
        let foundTodayFiles = false;

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
                      liveInput += usage.input_tokens || 0;
                      liveOutput += usage.output_tokens || 0;
                      liveCacheRead += usage.cache_read_input_tokens || 0;
                    }
                  } catch {}
                }
              }
            }
          }
        };

        walk(projectsDir);

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
   * Constructs an explicit self-budgeting prompt header that instructs
   * the receiving AI agent how to self-regulate its output and token budget.
   */
  public buildTokenBudgetDirective(agentId: AgentId, prompt: string, maxOutputTokens = 4000): string {
    const estInput = this.estimateTokens(prompt);
    const claudeStats = agentId === 'claude' ? this.readClaudeStats() : undefined;

    let header = `[TOKEN BUDGET & CONTEXT TELEMETRY]\n` +
      `• Estimated Directive Tokens: ~${estInput.toLocaleString()}\n` +
      `• Recommended Max Output: ~${maxOutputTokens.toLocaleString()} tokens\n`;

    if (claudeStats && claudeStats.todayTokens > 0) {
      header += `• Today's Claude Cumulative Tokens: ~${claudeStats.todayTokens.toLocaleString()} tokens\n`;
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
