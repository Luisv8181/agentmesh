export type AgentId = 'claude' | 'codex' | 'agy' | 'gemini' | 'opencode' | 'ollama';

export interface AgentStatus {
  id: AgentId;
  name: string;
  command: string;
  available: boolean;
  version: string | null;
  inCooldown: boolean;
  cooldownUntil: number | null;
  consecutiveErrors: number;
  lastUsed: number | null;
  lastError?: string;
  /** Why the agent can't be used right now, in plain language. */
  detail?: string;
  /** Position in the user's priority order, or null if the user turned this agent off. */
  priority: number | null;
  /** Paid subscription CLI (blocked in Safe Mode). */
  subscription: boolean;
  /** What the user should do, when the last attempt failed for a fixable reason (expired login, outdated CLI…). */
  hint?: string;
}

export type TaskStatus = 'pending' | 'in_progress' | 'blocked' | 'completed' | 'failed';

export type HandoffReason = 'rate_limit' | 'delegation' | 'specialization' | 'error' | 'phase_transition';

export interface HandoffRecord {
  handoffId: string;
  fromAgent: AgentId;
  toAgent: AgentId;
  reason: HandoffReason;
  summary: string;
  workDone: string[];
  nextSteps: string[];
  filesModified: string[];
  testResults?: {
    passed: boolean;
    summary: string;
  };
  timestamp: number;
}

export interface TaskState {
  taskId: string;
  title: string;
  status: TaskStatus;
  currentAgent?: AgentId;
  requirements: string[];
  acceptanceCriteria: string[];
  filesChanged: string[];
  handoffs: HandoffRecord[];
  workspaceRoot: string;
  gitBranch?: string;
  runs?: RunRecord[];
  createdAt: number;
  updatedAt: number;
}

export interface RunRecord {
  runId: string;
  instruction: string;
  agent?: AgentId;
  success: boolean;
  cancelled?: boolean;
  output: string;
  error?: string;
  handoffs: { from: AgentId; to: AgentId; reason: HandoffReason }[];
  filesChanged: string[];
  route?: RouteDecision;
  startedAt: number;
  durationMs: number;
}

export interface WorkExecutionResult {
  success: boolean;
  agent: AgentId;
  output: string;
  error?: string;
  cancelled?: boolean;
  handoffs: { from: AgentId; to: AgentId; reason: HandoffReason }[];
  /** Present when smart routing chose where this went. */
  route?: RouteDecision;
  durationMs: number;
}

export interface RouteDecision {
  kind: 'read' | 'edit';
  certainty: 'clear' | 'unclear';
  by: 'rule' | 'ollama' | 'default';
  reason: string;
}
