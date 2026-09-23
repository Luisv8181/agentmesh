import { v4 as uuidv4 } from 'uuid';
import { BaseAdapter } from '../adapters/base-adapter.js';
import { ClaudeAdapter } from '../adapters/claude-adapter.js';
import { CodexAdapter } from '../adapters/codex-adapter.js';
import { GeminiAdapter } from '../adapters/gemini-adapter.js';
import { OpenCodeAdapter } from '../adapters/opencode-adapter.js';
import { OllamaAdapter } from '../adapters/ollama-adapter.js';
import { RateLimiter } from './rate-limiter.js';
import { TaskStore } from '../state/task-store.js';
import { HandoffProtocol } from '../state/handoff-protocol.js';
import { GitCoordinator } from '../workspace/git-coordinator.js';
import {
  AgentId,
  AgentStatus,
  HandoffReason,
  HandoffRecord,
  TaskState,
  WorkExecutionResult
} from '../types.js';

export class AgentSelector {
  private adapters: Map<AgentId, BaseAdapter> = new Map();
  private rateLimiter: RateLimiter;
  private taskStore: TaskStore;
  private gitCoordinator: GitCoordinator;
  private defaultPriority: AgentId[];

  constructor(workspaceRoot = process.cwd()) {
    this.rateLimiter = new RateLimiter(workspaceRoot);
    this.taskStore = new TaskStore(workspaceRoot);
    this.gitCoordinator = new GitCoordinator(workspaceRoot);

    // Register built-in adapters
    this.register(new ClaudeAdapter());
    this.register(new CodexAdapter());
    this.register(new GeminiAdapter());
    this.register(new OpenCodeAdapter());
    this.register(new OllamaAdapter());

    this.defaultPriority = ['claude', 'codex', 'gemini', 'opencode', 'ollama'];
  }

  public register(adapter: BaseAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  public getStatuses(): AgentStatus[] {
    const list: AgentStatus[] = [];
    for (const [id, adapter] of this.adapters.entries()) {
      const avail = adapter.isAvailable();
      const rlState = this.rateLimiter.getState(id);
      const inCooldown = this.rateLimiter.isAgentInCooldown(id);

      list.push({
        id,
        name: adapter.name,
        command: adapter.command,
        available: avail.available,
        version: avail.version,
        inCooldown,
        cooldownUntil: inCooldown ? rlState.cooldownUntil : null,
        consecutiveErrors: rlState.consecutiveErrors,
        lastUsed: rlState.lastUsed,
        lastError: rlState.lastError
      });
    }
    return list;
  }

  public resetCooldowns(): void {
    this.rateLimiter.resetAll();
  }

  /**
   * Run a task across the mesh.
   * If an agent fails or is rate-limited, AgentMesh snapshots git changes,
   * constructs a work handoff brief, and immediately hands off to the next agent.
   */
  public async executeTask(
    task: TaskState,
    instruction: string,
    forcedAgent?: AgentId
  ): Promise<WorkExecutionResult> {
    const start = Date.now();
    const candidateQueue = this.resolveQueue(forcedAgent, task.currentAgent);

    let activeAgentIndex = 0;

    while (activeAgentIndex < candidateQueue.length) {
      const agentId = candidateQueue[activeAgentIndex];
      const adapter = this.adapters.get(agentId);

      if (!adapter) {
        activeAgentIndex++;
        continue;
      }

      if (this.rateLimiter.isAgentInCooldown(agentId)) {
        activeAgentIndex++;
        continue;
      }

      const check = adapter.isAvailable();
      if (!check.available) {
        activeAgentIndex++;
        continue;
      }

      // Prepare work brief for this agent
      let promptToAgent: string;
      if (task.handoffs.length > 0) {
        const lastHandoff = task.handoffs[task.handoffs.length - 1];
        promptToAgent = HandoffProtocol.buildHandoffBrief(task, lastHandoff) + `\n\n[Current Directive]\n${instruction}`;
      } else {
        promptToAgent = `[AgentMesh Directive - Initial Run]\nTask: ${task.title}\nRequirements:\n` +
          task.requirements.map((r, i) => `  ${i + 1}. ${r}`).join('\n') +
          `\n\nInstruction:\n${instruction}`;
      }

      const result = await adapter.execute(promptToAgent);

      if (result.success && result.output.trim().length > 0) {
        // Success!
        this.rateLimiter.recordSuccess(agentId);
        task.currentAgent = agentId;
        task.status = 'in_progress';
        this.taskStore.saveTask(task);

        return {
          success: true,
          agent: agentId,
          output: result.output.trim(),
          durationMs: Date.now() - start
        };
      }

      // Agent hit an issue or rate limit:
      const errorMsg = result.error || result.output || 'Unknown failure';
      const isRateLimit = this.rateLimiter.isRateLimit(errorMsg);
      const reason: HandoffReason = isRateLimit ? 'rate_limit' : 'error';

      if (isRateLimit) {
        this.rateLimiter.recordRateLimit(agentId, errorMsg);
      } else {
        this.rateLimiter.recordGenericError(agentId, errorMsg);
      }

      // Snapshot workspace changes and create checkpoint commit
      const gitSnapshot = this.gitCoordinator.getSnapshot();
      this.gitCoordinator.commitCheckpoint(task.taskId, agentId, candidateQueue[activeAgentIndex + 1] || 'ollama');

      // Find next candidate agent
      activeAgentIndex++;
      const nextAgent = candidateQueue[activeAgentIndex];

      if (nextAgent) {
        const handoffRecord: HandoffRecord = {
          handoffId: `handoff-${uuidv4().slice(0, 8)}`,
          fromAgent: agentId,
          toAgent: nextAgent,
          reason,
          summary: `${adapter.name} encountered ${reason}: ${errorMsg.slice(0, 100)}`,
          workDone: [`Attempted step with ${adapter.name}`],
          nextSteps: [`Resume implementation and address remaining requirements`],
          filesModified: gitSnapshot.modifiedFiles,
          timestamp: Date.now()
        };

        this.taskStore.recordHandoff(task, handoffRecord);
      }
    }

    throw new Error(`All available agents in AgentMesh exhausted for task '${task.taskId}'.`);
  }

  private resolveQueue(forced?: AgentId, current?: AgentId): AgentId[] {
    if (forced) return [forced];

    const queue: AgentId[] = [];
    if (current && !this.rateLimiter.isAgentInCooldown(current)) {
      queue.push(current);
    }

    for (const p of this.defaultPriority) {
      if (!queue.includes(p)) {
        queue.push(p);
      }
    }
    return queue;
  }
}
