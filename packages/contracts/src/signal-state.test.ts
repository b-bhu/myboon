import { describe, expect, it } from 'vitest';

import {
  JEV_DECISION_SCHEMA_VERSION,
  SIGNAL_STATES,
  jevDecisionSchema,
  jevOutcomeSchema,
  signalStateSchema,
} from './index.js';

const successRecord = {
  id: '01900000-0000-7000-8000-000000000000',
  signalId: 'a'.repeat(64),
  stage: 'linker',
  outcome: 'success',
  inputCase: { title: 't' },
  answer: { link: 'new_item' },
  probability: 0.82,
  runnerUp: { link: 'existing_item', probability: 0.11 },
  modelVersion: 'jev-1',
  error: null,
  latencyMs: 120,
  createdAt: '2026-10-26T10:00:00.000Z',
};

describe('JEV_DECISION_SCHEMA_VERSION', () => {
  it('is 1', () => {
    expect(JEV_DECISION_SCHEMA_VERSION).toBe(1);
  });
});

describe('signalStateSchema', () => {
  it('has the seven published states in order', () => {
    expect([...SIGNAL_STATES]).toEqual([
      'received',
      'analysed',
      'written',
      'parked',
      'dead_lettered',
      'discarded',
      'deleted',
    ]);
  });

  it('parses each state and rejects unknown ones', () => {
    for (const state of SIGNAL_STATES) expect(signalStateSchema.parse(state)).toBe(state);
    expect(signalStateSchema.safeParse('lost_claim').success).toBe(false);
    expect(signalStateSchema.safeParse('').success).toBe(false);
  });
});

describe('jevOutcomeSchema', () => {
  it('accepts success, error and timeout only', () => {
    for (const outcome of ['success', 'error', 'timeout'] as const) {
      expect(jevOutcomeSchema.parse(outcome)).toBe(outcome);
    }
    expect(jevOutcomeSchema.safeParse('retry').success).toBe(false);
  });
});

describe('jevDecisionSchema', () => {
  it('parses a full success record', () => {
    const decision = jevDecisionSchema.parse(successRecord);

    expect(decision.outcome).toBe('success');
    expect(decision.probability).toBe(0.82);
    expect(decision.runnerUp).toEqual({ link: 'existing_item', probability: 0.11 });
  });

  it('parses an error record without an answer', () => {
    const decision = jevDecisionSchema.parse({
      ...successRecord,
      outcome: 'error',
      answer: null,
      probability: null,
      runnerUp: null,
      error: 'upstream 502',
    });

    expect(decision.outcome).toBe('error');
    expect(decision.error).toBe('upstream 502');
  });

  it('rejects a probability outside [0, 1], including non-finite ones', () => {
    expect(jevDecisionSchema.safeParse({ ...successRecord, probability: 1.2 }).success).toBe(false);
    expect(jevDecisionSchema.safeParse({ ...successRecord, probability: -0.1 }).success).toBe(false);
    expect(jevDecisionSchema.safeParse({ ...successRecord, probability: Number.NaN }).success).toBe(false);
  });

  it('rejects success without an answer and error with one (SQL check mirror)', () => {
    expect(jevDecisionSchema.safeParse({ ...successRecord, answer: null }).success).toBe(false);
    expect(jevDecisionSchema.safeParse({ ...successRecord, outcome: 'error' }).success).toBe(false);
  });

  it('rejects a non-integer latency and a blank created_at', () => {
    expect(jevDecisionSchema.safeParse({ ...successRecord, latencyMs: 1.5 }).success).toBe(false);
    expect(jevDecisionSchema.safeParse({ ...successRecord, createdAt: '2026-10-26' }).success).toBe(false);
  });

  it('rejects an unknown outcome', () => {
    expect(jevDecisionSchema.safeParse({ ...successRecord, outcome: 'retry' }).success).toBe(false);
  });
});