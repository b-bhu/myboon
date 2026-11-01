import { describe, expect, it } from 'vitest';

import { ANALYST_OUTPUT_SCHEMA_VERSION, ENTITY_TYPES, parseAnalystOutput, safeParseAnalystOutput } from './analyst-output.js';

const target = (entity: string, over: Record<string, unknown> = {}) => ({
  entity, kind: 'existing', type: 'protocol', angle: 'existing_story', note: 'Reported by a news site.', ...over,
});
const base = {
  schema_version: 1,
  analyst_version: 'analyst-504-v1',
  signal_id: 'test-standuquesne-2115777839622689036',
  summary: 'An investor says trade(xyz) partners with ICE.',
  decision: 'keep',
  reason: 'Jev kept it.',
  targets: [target('trade-xyz'), target('hyperliquid')],
};

describe('#504 analyst output contract (D36)', () => {
  it('parses a keep output with targets', () => {
    const out = parseAnalystOutput(base);
    expect(out.targets).toHaveLength(2);
    expect(ANALYST_OUTPUT_SCHEMA_VERSION).toBe(1);
  });

  it('accepts ignore and unclear with no targets', () => {
    expect(parseAnalystOutput({ ...base, decision: 'ignore', targets: [] }).decision).toBe('ignore');
    expect(parseAnalystOutput({ ...base, decision: 'unclear', targets: [] }).decision).toBe('unclear');
  });

  it('rejects a 4th target', () => {
    const r = safeParseAnalystOutput({ ...base, targets: [target('a'), target('b'), target('c'), target('d')] });
    expect(r.success).toBe(false);
  });

  it('rejects duplicate entities, a bad angle, a bad kind and a non-entity type', () => {
    expect(safeParseAnalystOutput({ ...base, targets: [target('a'), target('a')] }).success).toBe(false);
    expect(safeParseAnalystOutput({ ...base, targets: [target('a', { angle: 'big_story' })] }).success).toBe(false);
    expect(safeParseAnalystOutput({ ...base, targets: [target('a', { kind: 'maybe' })] }).success).toBe(false);
    expect(safeParseAnalystOutput({ ...base, targets: [target('a', { type: 'jurisdiction' })] }).success).toBe(false);
  });

  it('rejects a non-kebab entity slug and an unknown decision', () => {
    expect(safeParseAnalystOutput({ ...base, targets: [target('Trade XYZ')] }).success).toBe(false);
    expect(safeParseAnalystOutput({ ...base, decision: 'skip' }).success).toBe(false);
  });

  it('ignore and unclear carry no targets', () => {
    expect(safeParseAnalystOutput({ ...base, decision: 'ignore' }).success).toBe(false);
  });

  it('entity types match the atlas.entities type check', () => {
    expect([...ENTITY_TYPES].sort()).toEqual(['asset', 'event', 'organization', 'person', 'place', 'product', 'protocol', 'regulation', 'topic']);
  });
});
