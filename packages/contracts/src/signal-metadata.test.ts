import { describe, expect, it } from 'vitest';

import { parseAnalystHandoff, signalMetadataSchema } from './signal-metadata.js';

const signal = {
  signal_id: 'a'.repeat(64), schema_version: 1, source: 'tokens_xyz', source_id: 'https://x.com/p/1', type: 'post', priority: 0,
  occurred_at: '2026-11-05T09:00:00.000Z', fetched_at: '2026-11-05T09:01:00.000Z', text: 'Solana passes $1B tokenized stock volume',
  numbers: {}, link: 'https://x.com/p/1', unusual_score: null, excerpt: 'Solana passes $1B tokenized stock volume', raw_hash: 'b'.repeat(64),
  raw_ids: { image: 'https://pbs.twimg.com/media/a.jpg', author: 'tokens', feed_source: 'x', handle: '@solana', extra_key: 'kept' },
  created_at: '2026-11-05T09:01:00.000Z',
};

describe('#571 signal metadata', () => {
  it('keeps every field unchanged, unknown raw_ids keys included', () => {
    expect(signalMetadataSchema.parse(signal)).toEqual(signal);
  });

  it('a news signal with no image or author parses', () => {
    const news = { ...signal, type: 'news', raw_ids: { feed_source: 'coingecko' } };
    expect(signalMetadataSchema.parse(news).raw_ids.image).toBeUndefined();
  });

  it('rejects a non-string raw_ids value', () => {
    expect(signalMetadataSchema.safeParse({ ...signal, raw_ids: { image: 3 } }).success).toBe(false);
  });
});

describe('#571 analyst handoff', () => {
  const base = { schema_version: 1, analyst_version: 'v', signal_id: signal.signal_id, reason: 'r', signal };
  const entity = { slug: 'solana', type: 'asset', angle: 'plain_update', note: 'n' };

  it('keep with an entity pick, or none', () => {
    expect(parseAnalystHandoff({ ...base, decision: 'keep', entity }).entity?.slug).toBe('solana');
    expect(parseAnalystHandoff({ ...base, decision: 'keep', entity: null }).entity).toBeNull();
  });

  it('ignore never carries an entity', () => {
    expect(() => parseAnalystHandoff({ ...base, decision: 'ignore', entity })).toThrow();
  });

  it('the signal must be the handed-over one', () => {
    expect(() => parseAnalystHandoff({ ...base, decision: 'keep', entity, signal_id: 'c'.repeat(64) })).toThrow();
  });
});
