import { EventEmitter } from 'events';
import { AgentId } from '../types.js';

export type TelemetryEventType =
  | 'request_start'
  | 'request_success'
  | 'rate_limit_hit'
  | 'cooldown_started'
  | 'cooldown_tick'
  | 'cooldown_expired'
  | 'handoff_triggered'
  | 'safe_mode_toggled';

export interface TelemetryEvent {
  id: string;
  type: TelemetryEventType;
  agentId?: AgentId;
  timestamp: number;
  message: string;
  details?: Record<string, any>;
}

export interface AgentUsageMetrics {
  id: AgentId;
  totalRequests: number;
  successfulRequests: number;
  rateLimitHits: number;
  otherErrors: number;
  consecutiveErrors: number;
  lastUsed: number | null;
  cooldownUntil: number | null;
  cooldownTotalDurationMs: number;
  currentCooldownRemainingSec: number;
  recoveryPercentage: number;
  status: 'ready' | 'cooldown' | 'active' | 'offline';
  recentEvents: TelemetryEvent[];
}

export class UsageMonitor extends EventEmitter {
  private metrics: Map<AgentId, AgentUsageMetrics> = new Map();
  private globalEvents: TelemetryEvent[] = [];
  private tickerTimer: NodeJS.Timeout | null = null;
  private safeMode = false;

  constructor() {
    super();
    this.startTicker();
  }

  public setSafeMode(enabled: boolean): void {
    this.safeMode = enabled;
    this.emitEvent({
      id: `ev-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      type: 'safe_mode_toggled',
      timestamp: Date.now(),
      message: `Local-Only Safe Mode ${enabled ? 'ENABLED' : 'DISABLED'}`,
      details: { safeMode: enabled }
    });
  }

  public isSafeMode(): boolean {
    return this.safeMode;
  }

  private getOrCreateMetrics(agentId: AgentId): AgentUsageMetrics {
    let m = this.metrics.get(agentId);
    if (!m) {
      m = {
        id: agentId,
        totalRequests: 0,
        successfulRequests: 0,
        rateLimitHits: 0,
        otherErrors: 0,
        consecutiveErrors: 0,
        lastUsed: null,
        cooldownUntil: null,
        cooldownTotalDurationMs: 0,
        currentCooldownRemainingSec: 0,
        recoveryPercentage: 100,
        status: 'ready',
        recentEvents: []
      };
      this.metrics.set(agentId, m);
    }
    return m;
  }

  public recordRequestStart(agentId: AgentId, instruction: string): void {
    const m = this.getOrCreateMetrics(agentId);
    m.totalRequests++;
    m.lastUsed = Date.now();
    m.status = 'active';

    this.emitEvent({
      id: `ev-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      type: 'request_start',
      agentId,
      timestamp: Date.now(),
      message: `Started execution on [${agentId}]`,
      details: { instruction: instruction.slice(0, 80) }
    });
  }

  public recordRequestSuccess(agentId: AgentId, durationMs: number): void {
    const m = this.getOrCreateMetrics(agentId);
    m.successfulRequests++;
    m.consecutiveErrors = 0;
    m.status = 'ready';

    this.emitEvent({
      id: `ev-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      type: 'request_success',
      agentId,
      timestamp: Date.now(),
      message: `[${agentId}] completed execution in ${(durationMs / 1000).toFixed(2)}s`,
      details: { durationMs }
    });
  }

  public recordRateLimit(agentId: AgentId, reason: string, cooldownDurationMs: number): void {
    const m = this.getOrCreateMetrics(agentId);
    m.rateLimitHits++;
    m.consecutiveErrors++;
    m.cooldownUntil = Date.now() + cooldownDurationMs;
    m.cooldownTotalDurationMs = cooldownDurationMs;
    m.currentCooldownRemainingSec = Math.ceil(cooldownDurationMs / 1000);
    m.recoveryPercentage = 0;
    m.status = 'cooldown';

    this.emitEvent({
      id: `ev-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      type: 'rate_limit_hit',
      agentId,
      timestamp: Date.now(),
      message: `Rate limit hit on [${agentId}]. Cooldown: ${Math.round(cooldownDurationMs / 1000)}s`,
      details: { reason, cooldownDurationMs }
    });
  }

  public recordHandoff(fromAgent: AgentId, toAgent: AgentId, reason: string, taskId: string): void {
    this.emitEvent({
      id: `ev-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      type: 'handoff_triggered',
      agentId: fromAgent,
      timestamp: Date.now(),
      message: `Handoff from [${fromAgent}] ──> [${toAgent}] (${reason})`,
      details: { fromAgent, toAgent, reason, taskId }
    });
  }

  public resetCooldown(agentId: AgentId): void {
    const m = this.getOrCreateMetrics(agentId);
    m.cooldownUntil = null;
    m.cooldownTotalDurationMs = 0;
    m.currentCooldownRemainingSec = 0;
    m.recoveryPercentage = 100;
    m.consecutiveErrors = 0;
    m.status = 'ready';

    this.emitEvent({
      id: `ev-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      type: 'cooldown_expired',
      agentId,
      timestamp: Date.now(),
      message: `Cooldown reset for [${agentId}]. Agent restored to Ready.`,
      details: {}
    });
  }

  public getAgentMetrics(agentId: AgentId): AgentUsageMetrics {
    const m = this.getOrCreateMetrics(agentId);
    this.updateCooldownState(m);
    return { ...m };
  }

  public getAllMetrics(): Record<AgentId, AgentUsageMetrics> {
    const result = {} as Record<AgentId, AgentUsageMetrics>;
    for (const [id, m] of this.metrics.entries()) {
      this.updateCooldownState(m);
      result[id] = { ...m };
    }
    return result;
  }

  public getRecentEvents(limit = 50): TelemetryEvent[] {
    return this.globalEvents.slice(-limit);
  }

  private updateCooldownState(m: AgentUsageMetrics): void {
    if (!m.cooldownUntil) {
      m.currentCooldownRemainingSec = 0;
      m.recoveryPercentage = 100;
      if (m.status === 'cooldown') m.status = 'ready';
      return;
    }

    const now = Date.now();
    const remainingMs = m.cooldownUntil - now;
    if (remainingMs <= 0) {
      m.cooldownUntil = null;
      m.currentCooldownRemainingSec = 0;
      m.recoveryPercentage = 100;
      m.status = 'ready';
      this.emitEvent({
        id: `ev-${now}-${Math.random().toString(36).slice(2, 7)}`,
        type: 'cooldown_expired',
        agentId: m.id,
        timestamp: now,
        message: `Cooldown expired on [${m.id}]. Restored to Ready.`,
        details: {}
      });
    } else {
      m.currentCooldownRemainingSec = Math.ceil(remainingMs / 1000);
      const elapsedMs = m.cooldownTotalDurationMs - remainingMs;
      m.recoveryPercentage = Math.min(100, Math.max(0, Math.round((elapsedMs / m.cooldownTotalDurationMs) * 100)));
      m.status = 'cooldown';
    }
  }

  private emitEvent(event: TelemetryEvent): void {
    this.globalEvents.push(event);
    if (this.globalEvents.length > 200) {
      this.globalEvents.shift();
    }
    if (event.agentId) {
      const m = this.metrics.get(event.agentId);
      if (m) {
        m.recentEvents.push(event);
        if (m.recentEvents.length > 20) m.recentEvents.shift();
      }
    }
    this.emit('telemetry', event);
  }

  private startTicker(): void {
    // Ticks every second to keep live countdown meters active
    this.tickerTimer = setInterval(() => {
      let hasCooling = false;
      for (const m of this.metrics.values()) {
        if (m.cooldownUntil) {
          hasCooling = true;
          this.updateCooldownState(m);
        }
      }
      if (hasCooling) {
        this.emit('tick', this.getAllMetrics());
      }
    }, 1000);

    // Prevent keeping process open if nothing else is running
    if (this.tickerTimer.unref) {
      this.tickerTimer.unref();
    }
  }

  public destroy(): void {
    if (this.tickerTimer) {
      clearInterval(this.tickerTimer);
      this.tickerTimer = null;
    }
  }
}

// Global Singleton for easy cross-module sharing
export const globalUsageMonitor = new UsageMonitor();
