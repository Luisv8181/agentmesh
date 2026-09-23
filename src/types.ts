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
  createdAt: number;
  updatedAt: number;
}

export interface WorkExecutionResult {
  success: boolean;
  agent: AgentId;
  output: string;
  error?: string;
  handoffTriggered?: boolean;
  durationMs: number;
}
