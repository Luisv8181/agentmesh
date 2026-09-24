import { v4 as uuidv4 } from 'uuid';
import { BaseAdapter } from '../adapters/base-adapter.js';
import { ClaudeAdapter } from '../adapters/claude-adapter.js';
import { CodexAdapter } from '../adapters/codex-adapter.js';
import { AgyAdapter } from '../adapters/agy-adapter.js';
import { GeminiAdapter } from '../adapters/gemini-adapter.js';
import { OpenCodeAdapter } from '../adapters/opencode-adapter.js';
import { OllamaAdapter } from '../adapters/ollama-adapter.js';
import { RateLimiter } from './rate-limiter.js';
import { TaskStore } from '../state/task-store.js';
import { HandoffProtocol } from '../state/handoff-protocol.js';
import { ConfigStore, agentMeshHome } from '../state/config-store.js';
import { GitCoordinator } from '../workspace/git-coordinator.js';
import { snapshotFiles, diffSnapshots } from '../workspace/change-tracker.js';
import { globalUsageMonitor } from './usage-monitor.js';
import { globalTokenTracker } from './token-tracker.js';
import { keyErrorLine, fixHint } from './error-hints.js';
import { classify, Classification } from './task-classifier.js';
import { BatonStore } from '../baton/baton-store.js';
import {
  AgentId,
  AgentStatus,
  HandoffReason,
  HandoffRecord,
  RunRecord,
  TaskState,
  WorkExecutionResult
} from '../types.js';

/** Everything except local Ollama can cost money, so Safe Mode blocks all of them. */
export const SUBSCRIPTION_AGENTS: AgentId[] = ['claude', 'codex', 'agy', 'gemini', 'opencode'];

const MAX_STORED_OUTPUT = 50_000;
const MAX_STORED_RUNS = 50;

export interface RunHooks {
  runId?: string;
  signal?: AbortSignal;
  onAgentStart?: (agentId: AgentId) => void;
  onOutput?: (agentId: AgentId, chunk: string) => void;
  onHandoff?: (from: AgentId, to: AgentId, reason: HandoffReason, error: string) => void;
  /** Smart routing decided where this goes (only when smart routing is on). */
  onRoute?: (route: Classification) => void;
  /** Skip smart routing's question detection ("Redo with a coding agent"). */
  forceEdit?: boolean;
}

export class AgentSelector {
  private adapters: Map<AgentId, BaseAdapter> = new Map();
  private rateLimiter: RateLimiter;
  private taskStore: TaskStore;
  private gitCoordinator: GitCoordinator;
  private safeMode = false;
  readonly workspaceRoot: string;
  readonly config: ConfigStore;

  constructor(workspaceRoot = process.cwd(), safeMode = false, config = new ConfigStore()) {
    this.workspaceRoot = workspaceRoot;
    this.config = config;
    this.rateLimiter = new RateLimiter(agentMeshHome());
    this.taskStore = new TaskStore(workspaceRoot);
    this.gitCoordinator = new GitCoordinator(workspaceRoot);
    this.safeMode = safeMode || process.env.AGENTMESH_SAFE_MODE === 'true';

    this.register(new ClaudeAdapter());
    this.register(new CodexAdapter());
    this.register(new AgyAdapter());
    this.register(new GeminiAdapter());
    this.register(new OpenCodeAdapter());
    this.register(new OllamaAdapter(undefined, config.get().ollamaModel));

    globalUsageMonitor.setSafeMode(this.safeMode);
  }

  public setSafeMode(enabled: boolean): void {
    this.safeMode = enabled;
    globalUsageMonitor.setSafeMode(enabled);
  }

  public isSafeMode(): boolean {
    return this.safeMode;
  }

  public register(adapter: BaseAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  /** Re-applies settings that adapters cache (e.g. the Ollama model) after the config changes. */
  public reloadConfig(): void {
    const ollama = this.adapters.get('ollama');
    if (ollama instanceof OllamaAdapter) {
      ollama.model = this.config.get().ollamaModel;
    }
  }

  public async getStatuses(forceRecheck = false): Promise<AgentStatus[]> {
    const { priority } = this.config.get();
    const entries = [...this.adapters.entries()];
    const checks = await Promise.all(entries.map(([, a]) => a.isAvailable(forceRecheck)));

    return entries
      .map(([id, adapter], i) => {
        const rl = this.rateLimiter.getState(id);
        const inCooldown = this.rateLimiter.isAgentInCooldown(id);
        const idx = priority.indexOf(id);
        return {
          id,
          name: adapter.name,
          command: adapter.command,
          available: checks[i].available,
          version: checks[i].version,
          detail: checks[i].detail,
          inCooldown,
          cooldownUntil: inCooldown ? rl.cooldownUntil : null,
          consecutiveErrors: rl.consecutiveErrors,
          lastUsed: rl.lastUsed,
          lastError: rl.lastError,
          priority: idx === -1 ? null : idx,
          subscription: SUBSCRIPTION_AGENTS.includes(id),
          hint: rl.consecutiveErrors > 0 && rl.lastError ? fixHint(id, adapter.name, rl.lastError) ?? undefined : undefined
        };
      })
      .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99));
  }

  public resetCooldowns(): void {
    this.rateLimiter.resetAll();
  }

  public resetAgent(agentId: AgentId): void {
    this.rateLimiter.resetAgent(agentId);
  }

  /**
   * Runs one instruction on a task. If the agent is rate-limited or fails, the next
   * agent in the user's priority order picks up with a brief of the work so far.
   */
  public async executeTask(
    task: TaskState,
    instruction: string,
    forcedAgent?: AgentId,
    hooks: RunHooks = {}
  ): Promise<WorkExecutionResult> {
    const start = Date.now();

    if (this.safeMode && forcedAgent && SUBSCRIPTION_AGENTS.includes(forcedAgent)) {
      throw new Error(
        `Safe Mode is enabled. Subscription agent '${forcedAgent}' is blocked to protect your quota. Disable safe mode or use local Ollama.`
      );
    }

    const { autoCommit, permission: configuredPermission, models, smartRouting, priority } = this.config.get();
    let queue = this.resolveQueue(forcedAgent, task.currentAgent);
    let permission = configuredPermission;
    let route: Classification | undefined;

    if (smartRouting && !forcedAgent && !this.safeMode) {
      const ollama = this.adapters.get('ollama');
      const ollamaUsable =
        !!ollama && priority.includes('ollama') && !this.rateLimiter.isAgentInCooldown('ollama') && (await ollama.isAvailable()).available;
      const tieBreaker = ollamaUsable && ollama instanceof OllamaAdapter ? { baseUrl: ollama.endpoint, model: ollama.model } : undefined;
      route = hooks.forceEdit
        ? { kind: 'edit', certainty: 'clear', by: 'rule', reason: 'you asked for a coding agent' }
        : await classify(instruction, tieBreaker);
      hooks.onRoute?.(route);

      if (route.kind === 'read') {
        // Questions: free local model first, and nobody gets to change files while answering.
        permission = 'readonly';
        if (ollamaUsable) queue = ['ollama', ...queue.filter((a) => a !== 'ollama')];
      } else {
        // Edits never go to Ollama: it can't change files and has claimed edits it didn't make.
        queue = queue.filter((a) => a !== 'ollama');
      }
    }
    const before = snapshotFiles(this.workspaceRoot);
    const handoffs: WorkExecutionResult['handoffs'] = [];
    const skipped: string[] = [];
    let previous: { agentId: AgentId; name: string; reason: HandoffReason; error: string } | null = null;
    let last: { agentId: AgentId; output: string; error: string } | null = null;

    const finish = (result: Omit<WorkExecutionResult, 'durationMs' | 'handoffs'>): WorkExecutionResult => {
      const full: WorkExecutionResult = { ...result, handoffs, route, durationMs: Date.now() - start };
      this.recordRun(task, instruction, full, start, diffSnapshots(before, snapshotFiles(this.workspaceRoot)), hooks.runId);
      return full;
    };

    for (const agentId of queue) {
      const adapter = this.adapters.get(agentId);
      if (!adapter) continue;

      if (this.rateLimiter.isAgentInCooldown(agentId)) {
        const secs = this.rateLimiter.getCooldownRemainingSec(agentId);
        skipped.push(`${adapter.name}: resting after a limit (${formatWait(secs)} left)`);
        continue;
      }

      const check = await adapter.isAvailable();
      if (!check.available) {
        skipped.push(`${adapter.name}: ${check.detail || 'not available'}`);
        continue;
      }

      if (previous) {
        const handoff = this.recordHandoff(task, previous, agentId, autoCommit);
        handoffs.push({ from: handoff.fromAgent, to: handoff.toAgent, reason: handoff.reason });
        hooks.onHandoff?.(previous.agentId, agentId, previous.reason, previous.error);
      }

      hooks.onAgentStart?.(agentId);
      globalUsageMonitor.recordRequestStart(agentId, instruction);

      let prompt = this.buildPrompt(task, instruction, permission);
      prompt = `${globalTokenTracker.buildTokenBudgetDirective(agentId, prompt)}\n${prompt}`;

      const result = await adapter.execute(prompt, {
        cwd: this.workspaceRoot,
        permission,
        model: models[agentId],
        signal: hooks.signal,
        onOutput: hooks.onOutput ? (chunk) => hooks.onOutput!(agentId, chunk) : undefined
      });

      globalTokenTracker.recordUsage(
        agentId,
        globalTokenTracker.estimateTokens(prompt) + globalTokenTracker.estimateTokens(result.output)
      );

      if (result.cancelled) {
        return finish({ success: false, cancelled: true, agent: agentId, output: result.output, error: 'Stopped by user' });
      }

      if (result.success && result.output.trim().length > 0) {
        this.rateLimiter.recordSuccess(agentId);
        globalUsageMonitor.recordRequestSuccess(agentId, result.durationMs);
        task.currentAgent = agentId;
        task.status = 'in_progress';
        return finish({ success: true, agent: agentId, output: result.output.trim() });
      }

      const error = result.error || result.output || 'Unknown failure';
      const reason: HandoffReason = this.rateLimiter.isRateLimit(error, prompt) ? 'rate_limit' : 'error';
      if (reason === 'rate_limit') {
        this.rateLimiter.recordRateLimit(agentId, error);
      } else {
        this.rateLimiter.recordGenericError(agentId, error);
      }
      previous = { agentId, name: adapter.name, reason, error };
      last = { agentId, output: result.output, error };
    }

    const lines: string[] = [];
    if (previous) {
      const hint = fixHint(previous.agentId, previous.name, previous.error);
      lines.push(`${previous.name} failed: ${keyErrorLine(previous.error)}${hint ? `\n  → ${hint}` : ''}`);
    }
    lines.push(...skipped);
    const summary = lines.length
      ? `No agent could finish this.\n${lines.map((l) => `• ${l}`).join('\n')}`
      : 'No agents are turned on. Open Settings and turn at least one on.';

    return finish({
      success: false,
      agent: last?.agentId ?? queue[0] ?? 'ollama',
      output: last?.output ?? '',
      error: summary
    });
  }

  private recordHandoff(
    task: TaskState,
    from: { agentId: AgentId; name: string; reason: HandoffReason; error: string },
    to: AgentId,
    autoCommit: boolean
  ): HandoffRecord {
    const snapshot = this.gitCoordinator.getSnapshot();
    if (autoCommit) {
      this.gitCoordinator.commitCheckpoint(task.taskId, from.agentId, to);
    }
    globalUsageMonitor.recordHandoff(from.agentId, to, from.reason, task.taskId);

    const record: HandoffRecord = {
      handoffId: `handoff-${uuidv4().slice(0, 8)}`,
      fromAgent: from.agentId,
      toAgent: to,
      reason: from.reason,
      summary: `${from.name} stopped (${from.reason === 'rate_limit' ? 'usage limit' : 'error'}): ${from.error.slice(0, 160)}`,
      workDone: [`${from.name} worked on the current instruction before stopping`],
      nextSteps: ['Check the current state of the files, then finish the current instruction'],
      filesModified: [...snapshot.modifiedFiles, ...snapshot.untrackedFiles],
      timestamp: Date.now()
    };
    this.taskStore.recordHandoff(task, record);
    return record;
  }

  private buildPrompt(task: TaskState, instruction: string, permission: 'edit' | 'readonly'): string {
    const parts: string[] = [];
    if (task.handoffs.length > 0) {
      parts.push(HandoffProtocol.buildHandoffBrief(task, task.handoffs[task.handoffs.length - 1]));
    } else {
      parts.push(
        `[AgentMesh Task]\nTask: ${task.title}\nOverall goal (set when the task was created):\n` +
          task.requirements.map((r, i) => `  ${i + 1}. ${r}`).join('\n')
      );
    }

    // Work done in the person's AI chats (ChatGPT/Claude/Gemini), carried over with "mesh wrap".
    const brief = new BatonStore(this.workspaceRoot).latestBrief();
    if (brief) {
      parts.push(`[Latest project brief from the person's AI chats, ${new Date(brief.at).toISOString().slice(0, 10)}]\n${brief.text.slice(0, 4000)}`);
    }

    const recent = (task.runs || []).filter((r) => r.success).slice(-3);
    if (recent.length > 0) {
      parts.push(
        '[Earlier steps on this task]\n' +
          recent
            .map((r) => {
              const files = r.filesChanged.length ? ` Files changed: ${r.filesChanged.slice(0, 10).join(', ')}.` : '';
              return `- "${r.instruction.slice(0, 200)}" (done by ${r.agent}).${files} Result: ${r.output.slice(0, 300).replace(/\s+/g, ' ')}`;
            })
            .join('\n')
      );
    }

    parts.push(
      `[Project folder]\n${this.workspaceRoot}\n` +
        'Every file you read, create or edit is inside this folder. Use absolute paths when your tools require them.'
    );

    if (permission === 'readonly') {
      parts.push('[Mode] Read-only: do not modify any files. Explain what you would change instead.');
    } else {
      // Headless edit modes auto-deny shell commands (nobody is there to approve them), and an agent that
      // reaches for the shell first fails with no output.
      parts.push(
        '[Mode] You may create and edit files in this folder. Use your built-in file read/write/edit tools; ' +
          'shell or terminal commands may be blocked in this mode, so do not rely on them.'
      );
    }

    parts.push(
      `[Current Instruction: do this now]\n${instruction}\n\n` +
        'This is the latest request from the user. If it differs from the overall goal or earlier steps, follow this one.'
    );
    return parts.join('\n\n');
  }

  private recordRun(
    task: TaskState,
    instruction: string,
    result: WorkExecutionResult,
    startedAt: number,
    filesChanged: string[],
    runId?: string
  ): void {
    const record: RunRecord = {
      runId: runId ?? `run-${uuidv4().slice(0, 8)}`,
      instruction,
      agent: result.agent,
      success: result.success,
      cancelled: result.cancelled,
      output: result.output.slice(0, MAX_STORED_OUTPUT),
      error: result.error,
      handoffs: result.handoffs,
      filesChanged,
      route: result.route,
      startedAt,
      durationMs: result.durationMs
    };
    task.runs = [...(task.runs || []), record].slice(-MAX_STORED_RUNS);
    task.filesChanged = [...new Set([...task.filesChanged, ...filesChanged.filter((f) => !f.endsWith('(deleted)'))])];
    this.taskStore.saveTask(task);
  }

  private resolveQueue(forced?: AgentId, current?: AgentId): AgentId[] {
    if (forced) {
      if (this.safeMode && SUBSCRIPTION_AGENTS.includes(forced)) {
        throw new Error(`Safe Mode is enabled: cannot route to subscription agent '${forced}'.`);
      }
      return [forced];
    }

    const { priority } = this.config.get();
    let queue: AgentId[] = [];
    // Stick with the agent already working on this task, if the user still has it turned on.
    // Never stick with Ollama: it's the chat-only fallback and can't edit files.
    if (current && current !== 'ollama' && priority.includes(current) && !this.rateLimiter.isAgentInCooldown(current)) {
      queue.push(current);
    }
    for (const p of priority) {
      if (!queue.includes(p)) queue.push(p);
    }

    if (this.safeMode) {
      queue = ['ollama'];
    }
    return queue;
  }
}

function formatWait(secs: number): string {
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.ceil(secs / 60)} min`;
  return `${Math.floor(secs / 3600)}h ${Math.ceil((secs % 3600) / 60)}m`;
}
