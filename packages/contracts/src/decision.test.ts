import { describe, expect, it } from 'vitest';

import { DECISION_SCHEMA_VERSION, parseDecision, safeParseDecision } from './index.js';

const uuidA = '11111111-1111-4111-8111-111111111111';
const uuidB = '22222222-2222-4222-8222-222222222222';

const validFileDecision = {
  decision_type: 'file',
  schema_version: DECISION_SCHEMA_VERSION,
  signal_id: 'a'.repeat(64),
  analyst_version: 'analyst-v1',
  shelves: [
    { shelf_id: uuidA, role: 'main' },
    { shelf_id: uuidB, role: 'also_affects' },
  ],
  target_item_id: null,
  item_key: 'polymarket/us-iran-deal',
  action: 'keep',
  reason: 'matches existing shelf',
  confidence: 0.8,
};

const validMergeDecision = {
  decision_type: 'merge',
  schema_version: DECISION_SCHEMA_VERSION,
  signal_id: 'b'.repeat(64),
  analyst_version: 'analyst-v1',
  target_item_id: uuidA,
  merged_into_id: uuidB,
  reason: 'duplicate of survivor item',
  confidence: 0.75,
};

describe('decisionSchema (file)', () => {
  it('parses a valid file decision', () => {
    const decision = parseDecision(validFileDecision);

    expect(decision.decision_type).toBe('file');
    expect(decision.schema_version).toBe(1);
    expect(decision.shelves).toHaveLength(2);
    expect(decision.target_item_id).toBeNull();
  });

  it('rejects shelves with zero main roles', () => {
    const result = safeParseDecision({
      ...validFileDecision,
      shelves: [
        { shelf_id: uuidA, role: 'also_affects' },
        { shelf_id: uuidB, role: 'also_affects' },
      ],
    });

    expect(result.success).toBe(false);
  });

  it('rejects shelves with two main roles', () => {
    const result = safeParseDecision({
      ...validFileDecision,
      shelves: [
        { shelf_id: uuidA, role: 'main' },
        { shelf_id: uuidB, role: 'main' },
      ],
    });

    expect(result.success).toBe(false);
  });
});

describe('decisionSchema (required fields)', () => {
  it('rejects a decision missing schema_version', () => {
    const { schema_version: _schema_version, ...withoutSchemaVersion } = validFileDecision;

    expect(safeParseDecision(withoutSchemaVersion).success).toBe(false);
  });

  it('rejects a decision missing analyst_version', () => {
    const { analyst_version: _analyst_version, ...withoutAnalystVersion } = validFileDecision;

    expect(safeParseDecision(withoutAnalystVersion).success).toBe(false);
  });
});

describe('decisionSchema (merge)', () => {
  it('parses a valid merge decision', () => {
    const decision = parseDecision(validMergeDecision);

    expect(decision.decision_type).toBe('merge');
    expect(decision.target_item_id).toBe(uuidA);
    expect(decision.merged_into_id).toBe(uuidB);
  });

  it('rejects a merge with merged_into_id equal to target_item_id', () => {
    const result = safeParseDecision({ ...validMergeDecision, merged_into_id: uuidA });

    expect(result.success).toBe(false);
  });
});