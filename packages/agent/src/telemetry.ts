import { AgentError, positive } from './common.js';
import type { Scope } from './types.js';

export type TimingStage = 'input' | 'observation' | 'decision' | 'thought' | 'execution' | 'verification' | 'output';
export interface TimingSample {
  scope: Scope;
  stage: TimingStage;
  at: number;
  durationMs?: number;
  queueMs?: number;
  observationAgeMs?: number;
  executionId?: string;
  outcome: 'received' | 'started' | 'completed' | 'failed' | 'cancelled' | 'discarded' | 'deadline' | 'unknown';
}
export interface Percentiles { count: number; p50: number | null; p95: number | null; p99: number | null; max: number | null }
export function percentiles(values: readonly number[]): Percentiles {
  const sorted = values.filter(v => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
  const quantile = (p: number) => sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] : null;
  return { count: sorted.length, p50: quantile(.5), p95: quantile(.95), p99: quantile(.99), max: sorted.at(-1) ?? null };
}

/** Bounded timing metadata only; known fields are copied explicitly. */
export class Telemetry {
  private samples: TimingSample[] = [];
  private limit: number;
  constructor(limit = 512) {
    this.limit = positive(limit, 'telemetryLimit');
    if (!Number.isSafeInteger(limit) || limit > 10000) throw new AgentError('configuration', 'Invalid telemetry limit.');
  }
  record(sample: TimingSample): void {
    if (![sample.at, sample.durationMs ?? 0, sample.queueMs ?? 0, sample.observationAgeMs ?? 0].every(Number.isFinite)
      || [sample.durationMs, sample.queueMs, sample.observationAgeMs].some(v => v !== undefined && v < 0)) {
      throw new AgentError('invalid_timing', 'Expected finite nonnegative durations.');
    }
    this.samples.push({ scope: { epoch: sample.scope.epoch, turnId: sample.scope.turnId, revision: sample.scope.revision },
      stage: sample.stage, at: sample.at, outcome: sample.outcome,
      ...(sample.durationMs === undefined ? {} : { durationMs: sample.durationMs }),
      ...(sample.queueMs === undefined ? {} : { queueMs: sample.queueMs }),
      ...(sample.observationAgeMs === undefined ? {} : { observationAgeMs: sample.observationAgeMs }),
      ...(sample.executionId === undefined ? {} : { executionId: sample.executionId }) });
    this.samples = this.samples.slice(-this.limit);
  }
  snapshot(): TimingSample[] { return structuredClone(this.samples); }
  summary() {
    const stages: TimingStage[] = ['input', 'observation', 'decision', 'thought', 'execution', 'verification', 'output'];
    return Object.fromEntries(stages.map(stage => {
      const samples = this.samples.filter(s => s.stage === stage);
      return [stage, { durationMs: percentiles(samples.flatMap(s => s.durationMs === undefined ? [] : [s.durationMs])),
        queueMs: percentiles(samples.flatMap(s => s.queueMs === undefined ? [] : [s.queueMs])),
        deadlineMisses: samples.filter(s => s.outcome === 'deadline').length,
        discarded: samples.filter(s => s.outcome === 'discarded').length }];
    }));
  }
  clear(): void { this.samples = []; }
}
