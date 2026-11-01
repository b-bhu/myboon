import { describe, expect, it } from 'vitest';

import { parseSignal, safeParseSignal, signalId } from './index.js';
import { newsSampleRows, newsSampleSignals } from './test-fixtures/news-samples.js';

describe('signalId', () => {
  it('is deterministic for the same source and source_id', () => {
    expect(signalId('news', 'https://x.test/a')).toBe(signalId('news', 'https://x.test/a'));
  });

  it('differs for different inputs, including the "ab"+"c" vs "a"+"bc" boundary case', () => {
    expect(signalId('ab', 'c')).not.toBe(signalId('a', 'bc'));
    expect(signalId('news', 'https://x.test/a')).not.toBe(signalId('news', 'https://x.test/b'));
    expect(signalId('news', 'https://x.test/a')).not.toBe(signalId('post', 'https://x.test/a'));
  });

  it('returns a 64-char lowercase sha256 hex string', () => {
    expect(signalId('news', 'https://x.test/a')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('signalSchema (news fixtures)', () => {
  it('parses the three real news samples', () => {
    for (const [index, sample] of newsSampleSignals.entries()) {
      const signal = parseSignal(sample);

      expect(signal.type).toBe('news');
      expect(signal.schema_version).toBe(1);
      expect(signal.priority).toBe(0);
      expect(signal.numbers).toEqual({});
      expect(signal.signal_id).toBe(signalId(sample.source, sample.source_id));
    }

    expect(newsSampleSignals).toHaveLength(3);
    expect(new Set(newsSampleSignals.map((sample) => sample.signal_id))).toHaveLength(3);
  });

  it('rejects a 2000-char excerpt', () => {
    const result = safeParseSignal({
      ...newsSampleSignals[0]!,
      excerpt: 'x'.repeat(2000),
    });

    expect(result.success).toBe(false);
  });

  it('rejects a wrong signal_id', () => {
    const result = safeParseSignal({
      ...newsSampleSignals[0]!,
      signal_id: '0'.repeat(64),
    });

    expect(result.success).toBe(false);
  });
});

describe('signalSchema.type/numbers strictness', () => {
  const base = newsSampleSignals[0]!;

  it('rejects news numbers that contain a price_move field', () => {
    const result = safeParseSignal({ ...base, numbers: { price: 1 } });

    expect(result.success).toBe(false);
  });

  it('accepts post numbers and rejects unknown keys there too', () => {
    const post = { ...base, type: 'post', numbers: { likes: 10, followers: 0 } };
    expect(safeParseSignal(post).success).toBe(true);
    expect(safeParseSignal({ ...post, numbers: { likes: 1, shares: 2 } }).success).toBe(false);
  });

  it('defaults omitted numbers to {} and raw_ids to {}', () => {
    const { numbers, raw_ids, ...rest } = base;
    const parsed = parseSignal(rest);

    expect(parsed.numbers).toEqual({});
    expect(parsed.raw_ids).toEqual({});
  });
});