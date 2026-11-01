import { describe, expect, it } from 'vitest';

import {
  DECISION_PROVENANCE_SCHEMA_VERSION,
  SIGNAL_STATUSES,
  decisionProvenanceSchema,
  parseSignalStatus,
  safeParseSignalStatus,
} from './index.js';

describe('signalStatusSchema', () => {
  it('has the six saved statuses of atlas.signals', () => {
    expect([...SIGNAL_STATUSES]).toEqual(['received', 'analysed', 'written', 'parked', 'dead', 'deleted']);
  });

  it('round-trips a status and rejects a fake one', () => {
    expect(parseSignalStatus('received')).toBe('received');
    expect(safeParseSignalStatus('claimed').success).toBe(false);
  });
});

describe('decisionProvenanceSchema (v1, matches the atlas.decisions provenance columns)', () => {
  const provenanceRow = {
    schema_version: DECISION_PROVENANCE_SCHEMA_VERSION,
    signal_id: 'a'.repeat(64),
    analyst_version: 'analyst-478-v1',
    decision_type: 'file',
    action: 'keep',
    confidence: 0.82,
    shortlist: [
      { slug: 'bitcoin', score: 2 },
      { slug: 'xrp', score: 1 },
    ],
    item_ids: ['00000000-0000-7000-8000-000000000001'],
    prompt_version: 'story-v1',
    model_name: 'jev',
    model_version: 'jev-1.13.0',
    decided_by: 'jev',
    answer: { choice: 'new_story' },
    probabilities: { new_story: 0.82, adds_nothing: 0.12, link: 0.06 },
    runner_up_margin: 0.7,
    latency_ms: 20,
    outcome: 'decided',
    primary_error: null,
    shadow_answer: { choice: 'adds_nothing' },
    shadow_probabilities: { adds_nothing: 0.7 },
    shadow_latency_ms: 45,
    shadow_outcome: 'decided',
    shadow_model_version: 'clef',
  };

  it('parses a decision row the analyst writes', () => {
    expect(decisionProvenanceSchema.parse(provenanceRow).decided_by).toBe('jev');
  });

  it('accepts a failed shadow (answer null) and a fallback decision with primary_error', () => {
    expect(
      decisionProvenanceSchema.safeParse({
        ...provenanceRow,
        shadow_answer: null,
        shadow_probabilities: null,
        shadow_latency_ms: null,
        shadow_outcome: 'error',
      }).success,
    ).toBe(true);
    expect(
      decisionProvenanceSchema.safeParse({
        ...provenanceRow,
        decided_by: 'clef',
        model_name: 'clef',
        model_version: 'clef',
        primary_error: 'out_of_credit: jev 402 payment required',
      }).success,
    ).toBe(true);
  });

  it('rejects a decided_by outside jev/clef and a runner-up margin outside 0..1', () => {
    expect(decisionProvenanceSchema.safeParse({ ...provenanceRow, decided_by: 'glm' }).success).toBe(false);
    expect(decisionProvenanceSchema.safeParse({ ...provenanceRow, runner_up_margin: 1.5 }).success).toBe(false);
    expect(decisionProvenanceSchema.safeParse({ ...provenanceRow, signal_id: 'b'.repeat(63) }).success).toBe(false);
  });
});