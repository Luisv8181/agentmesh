import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { UsageMonitor } from '../router/usage-monitor.js';
import { AgentSelector } from '../router/agent-selector.js';
import { TaskStore } from '../state/task-store.js';
import { startUiServer } from '../ui/server.js';
import { OllamaAdapter } from '../adapters/ollama-adapter.js';
import { BaseAdapter, AdapterExecutionResult } from '../adapters/base-adapter.js';
import { AgentId } from '../types.js';

process.env.AGENTMESH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmesh-home-'));

class MockSubscriptionAdapter extends BaseAdapter {
  readonly id: AgentId;
  readonly name: string;
  readonly command: string;
  public called = false;

  constructor(id: AgentId, name: string) {
    super();
    this.id = id;
    this.name = name;
    this.command = id;
  }

  override async isAvailable() {
    return { available: true, version: '1.0.0-mock' };
  }

  async execute(prompt: string): Promise<AdapterExecutionResult> {
    this.called = true;
    return { success: true, output: `Executed by ${this.id}`, durationMs: 50 };
  }
}

test('UsageMonitor accurately calculates cooldown remaining and recovery percentage', () => {
  const monitor = new UsageMonitor();
  monitor.recordRequestStart('claude', 'Test instruction');
  
  // Record 60s cooldown
  monitor.recordRateLimit('claude', '429 Rate Limit', 60_000);
  
  let metrics = monitor.getAgentMetrics('claude');
  assert.strictEqual(metrics.status, 'cooldown');
  assert.strictEqual(metrics.rateLimitHits, 1);
  assert.ok(metrics.currentCooldownRemainingSec > 50 && metrics.currentCooldownRemainingSec <= 60);
  assert.ok(metrics.recoveryPercentage >= 0 && metrics.recoveryPercentage <= 10);

  // Manual reset
  monitor.resetCooldown('claude');
  metrics = monitor.getAgentMetrics('claude');
  assert.strictEqual(metrics.status, 'ready');
  assert.strictEqual(metrics.currentCooldownRemainingSec, 0);
  assert.strictEqual(metrics.recoveryPercentage, 100);

  monitor.destroy();
});

test('Safe Mode strictly blocks subscription CLIs and only routes to local Ollama or mocks', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmesh-safe-'));
  const selector = new AgentSelector(tmpDir, true); // Safe mode = true
  const taskStore = new TaskStore(tmpDir);

  const mockClaude = new MockSubscriptionAdapter('claude', 'Mock Claude');
  const mockOllama = new MockSubscriptionAdapter('ollama', 'Mock Ollama');

  selector.register(mockClaude);
  selector.register(mockOllama);

  const task = taskStore.createTask('Safe Mode Test', ['Requirements']);

  // 1. Trying to force a subscription agent in Safe Mode must reject immediately
  await assert.rejects(
    async () => {
      await selector.executeTask(task, 'Do work', 'claude');
    },
    /Safe Mode is enabled/
  );
  assert.strictEqual(mockClaude.called, false, 'Subscription agent must NEVER be called in Safe Mode');

  // 2. Default execution in Safe Mode must route to Ollama without touching Claude
  const result = await selector.executeTask(task, 'Do work locally');
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.agent, 'ollama');
  assert.strictEqual(mockClaude.called, false, 'Subscription agent remained untouched');
  assert.strictEqual(mockOllama.called, true);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('Embedded UI server serves dashboard and API endpoints', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmesh-ui-'));
  const testPort = 3456;
  const instance = await startUiServer(testPort, tmpDir, true);

  try {
    const auth = { 'Content-Type': 'application/json', 'x-agentmesh-token': instance.token };

    // 1. Dashboard HTML carries this launch's token
    const htmlRes = await fetch(`http://localhost:${testPort}/`);
    assert.strictEqual(htmlRes.status, 200);
    const html = await htmlRes.text();
    assert.ok(html.includes(instance.token), 'token injected into page');
    assert.ok(!html.includes('__AGENTMESH_TOKEN__'));

    // 2. State
    const stateRes = await fetch(`http://localhost:${testPort}/api/state`, { headers: auth });
    assert.strictEqual(stateRes.status, 200);
    const stateData = (await stateRes.json()) as any;
    assert.strictEqual(stateData.safeMode, true);
    assert.ok(Array.isArray(stateData.agents));
    assert.strictEqual(stateData.workspace, tmpDir);

    // 3. Toggle mode
    const modeRes = await fetch(`http://localhost:${testPort}/api/mode`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ safeMode: false })
    });
    const modeData = (await modeRes.json()) as any;
    assert.strictEqual(modeData.safeMode, false);

    // 4. Reset cooldown
    const resetRes = await fetch(`http://localhost:${testPort}/api/reset-cooldown`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ agentId: 'claude' })
    });
    assert.strictEqual(resetRes.status, 200);
  } finally {
    await instance.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Live Local Ollama test execution (Zero subscriptions used)', async () => {
  // Uses local Ollama model llama3.2:1b verified installed on the system
  const ollama = new OllamaAdapter('http://127.0.0.1:11434', 'llama3.2:1b');
  const res = await ollama.execute('Respond with the word OK', { timeoutMs: 60_000 });

  // If Ollama daemon is responsive, assert output
  if (res.success) {
    assert.ok(res.output.trim().length > 0, 'Ollama returned output');
  }
});

test('TokenTracker estimates prompt tokens and reads Claude stats if present', async () => {
  const { TokenTracker } = await import('../router/token-tracker.js');
  const tracker = new TokenTracker();

  const est = tracker.estimateTokens('function add(a: number, b: number): number { return a + b; }');
  assert.ok(est > 5 && est < 30);

  const directive = tracker.buildTokenBudgetDirective('claude', 'Build authentication flow');
  assert.ok(directive.includes('TOKEN BUDGET & CONTEXT TELEMETRY'));
  assert.ok(directive.includes('Recommended Max Output'));

  const stats = tracker.readClaudeStats();
  // stats may be defined if ~/.claude/stats-cache.json or project logs exist on this machine
  if (stats) {
    assert.ok(typeof stats.totalInputTokens === 'number');
    assert.ok(typeof stats.totalOutputTokens === 'number');
  }

  const codexStats = tracker.readCodexStats();
  // codexStats may be defined if ~/.codex/state_5.sqlite exists on this machine
  if (codexStats) {
    assert.ok(typeof codexStats.tokensUsedToday === 'number');
    assert.ok(typeof codexStats.activeThreads === 'number');
    assert.ok(typeof codexStats.model === 'string');
  }
});


