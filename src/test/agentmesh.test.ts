import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { RateLimiter } from '../router/rate-limiter.js';
import { TaskStore } from '../state/task-store.js';
import { HandoffProtocol } from '../state/handoff-protocol.js';
import { AgentSelector } from '../router/agent-selector.js';
import { BaseAdapter, AdapterExecutionResult } from '../adapters/base-adapter.js';
import { AgentId } from '../types.js';

process.env.AGENTMESH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmesh-home-'));

class MockAgentAdapter extends BaseAdapter {
  id: AgentId;
  name: string;
  command: string;
  shouldFailWithRateLimit = false;
  lastPrompt = '';

  constructor(id: AgentId, name: string) {
    super();
    this.id = id;
    this.name = name;
    this.command = `mock-${id}`;
  }

  override async isAvailable() {
    return { available: true, version: '1.0.0-mock' };
  }

  async execute(prompt: string): Promise<AdapterExecutionResult> {
    this.lastPrompt = prompt;

    if (this.shouldFailWithRateLimit) {
      return {
        success: false,
        output: '',
        error: '429 Rate limit exceeded. Try again later.',
        durationMs: 10
      };
    }

    return {
      success: true,
      output: `Success from ${this.id}: Completed objective`,
      durationMs: 25
    };
  }
}

test('RateLimiter enforces cooldowns and backoffs', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmesh-rl-'));
  const rl = new RateLimiter(tmpDir);

  assert.strictEqual(rl.isRateLimit('429 Too Many Requests'), true);
  assert.strictEqual(rl.isRateLimit('Compile error'), false);

  const durationMs = rl.recordRateLimit('claude', 'Rate limit hit');
  assert.strictEqual(durationMs, 60_000);
  assert.strictEqual(rl.isAgentInCooldown('claude'), true);
  assert.strictEqual(rl.isAgentInCooldown('codex'), false);

  rl.resetAll();
  assert.strictEqual(rl.isAgentInCooldown('claude'), false);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('HandoffProtocol constructs structured work briefs', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmesh-handoff-'));
  const store = new TaskStore(tmpDir);

  const task = store.createTask('Build Auth Flow', ['Create JWT utility', 'Add login handler'], ['Tests must pass']);

  const brief = HandoffProtocol.buildHandoffBrief(task, {
    handoffId: 'h-1',
    fromAgent: 'claude',
    toAgent: 'codex',
    reason: 'rate_limit',
    summary: 'Claude hit rate limit after creating JWT util',
    workDone: ['Created src/jwt.ts'],
    nextSteps: ['Implement src/login.ts', 'Run npm test'],
    filesModified: ['src/jwt.ts'],
    timestamp: Date.now()
  });

  assert.ok(brief.includes('AGENTMESH WORK HANDOFF BRIEF'));
  assert.ok(brief.includes('Build Auth Flow'));
  assert.ok(brief.includes('[claude] ──> [codex]'));
  assert.ok(brief.includes('RATE_LIMIT'));
  assert.ok(brief.includes('Created src/jwt.ts'));
  assert.ok(brief.includes('Implement src/login.ts'));

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('AgentSelector executes task and triggers automatic handoff on rate limit', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmesh-selector-'));
  const selector = new AgentSelector(tmpDir);
  const store = new TaskStore(tmpDir);

  const mockClaude = new MockAgentAdapter('claude', 'Mock Claude');
  const mockCodex = new MockAgentAdapter('codex', 'Mock Codex');

  selector.register(mockClaude);
  selector.register(mockCodex);

  const task = store.createTask('Fix Database Migrations', ['Add column', 'Run migration']);

  // Claude hits rate limit on run
  mockClaude.shouldFailWithRateLimit = true;

  const result = await selector.executeTask(task, 'Start database migration work');

  // Verify it cleanly handed off to Codex!
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.agent, 'codex');

  // Verify task record has handoff saved
  const reloaded = store.getTask(task.taskId);
  assert.ok(reloaded);
  assert.strictEqual(reloaded.handoffs.length, 1);
  assert.strictEqual(reloaded.handoffs[0].fromAgent, 'claude');
  assert.strictEqual(reloaded.handoffs[0].toAgent, 'codex');
  assert.strictEqual(reloaded.handoffs[0].reason, 'rate_limit');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
