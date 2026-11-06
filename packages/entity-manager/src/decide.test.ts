import { describe, expect, it } from 'vitest';
import { parseAnalystHandoff } from '@myboon/contracts';

import { decide, emOutcome, signalImage, userMessage, validateDecision, type EntityRow, type RecentItem } from './decide.js';
import { SYSTEM_PROMPT } from './prompt.js';

const handoff = (over: Record<string, unknown> = {}) =>
  parseAnalystHandoff({
    schema_version: 1, analyst_version: 'analyst-567-v1', signal_id: 'sig-1', decision: 'keep', reason: 'kept',
    entity: { slug: 'hyperliquid', type: 'organization', angle: 'new_story', note: 'n' },
    signal: {
      signal_id: 'sig-1', schema_version: 1, source: 'scout-news', source_id: 'x1', type: 'news', priority: 0,
      occurred_at: '2026-11-06T08:00:00Z', fetched_at: '2026-11-06T08:01:00Z', text: 'Hyperliquid lists HYPE perps on new venue',
      numbers: {}, link: 'https://ex.com/a', raw_ids: { image: 'https://img.ex/a.png', outlet: 'The Block' }, unusual_score: null,
      excerpt: 'Hyperliquid lists HYPE perps on new venue', raw_hash: null, created_at: '2026-11-06T08:01:00Z',
    },
    ...over,
  });
const entity: EntityRow = { id: 'e1', slug: 'hyperliquid', name: 'Hyperliquid', type: 'organization', summary: 'Perp DEX' };
const items: RecentItem[] = [{ id: '0190-item-1', title: 'Hyperliquid TVL hits record', summary: 's', date: '2026-11-05T00:00:00.000Z' }];

describe('prompt', () => {
  it('is the agreed text', () => {
    expect(SYSTEM_PROMPT.startsWith('You are the entity manager for MyBoon.')).toBe(true);
    expect(SYSTEM_PROMPT).not.toMatch(/crypto news feed/);
    expect(SYSTEM_PROMPT).toContain('When unsure between story and park, choose park.');
  });
});

describe('userMessage', () => {
  it('carries ENTITY, RECENT ITEMS with ids, SIGNAL; no outlet name', () => {
    const m = userMessage(entity, items, handoff());
    expect(m).toContain('ENTITY:\nname: Hyperliquid');
    expect(m).toContain('id: 0190-item-1');
    expect(m).toContain('body: (missing)');
    expect(m).toContain('image: yes');
    expect(m).not.toContain('The Block');
  });
});

describe('signalImage', () => {
  it('https only, else null (no fallback)', () => {
    expect(signalImage(handoff())).toBe('https://img.ex/a.png');
    const h = handoff();
    h.signal.raw_ids.image = 'http://x';
    expect(signalImage(h)).toBeNull();
  });
});

describe('validateDecision', () => {
  it('story needs title <= 90 and summary', () => {
    expect(validateDecision({ decision: 'story', reason: 'r', title: 'T', summary: 'S' }, items)).toMatchObject({ decision: 'story' });
    expect(() => validateDecision({ decision: 'story', title: 'x'.repeat(91), summary: 'S' }, items)).toThrow();
    expect(() => validateDecision({ decision: 'story', title: 'T' }, items)).toThrow();
  });
  it('duplicate must point at a recent item', () => {
    expect(validateDecision({ decision: 'duplicate', duplicate_of: '0190-item-1' }, items)).toMatchObject({ duplicate_of: '0190-item-1' });
    expect(() => validateDecision({ decision: 'duplicate', duplicate_of: 'nope' }, items)).toThrow();
  });
  it('jev choice wins; unknown throws; park maps to parked', () => {
    expect(validateDecision({ decision: 'story', title: 'T', summary: 'S' }, items, 'park').decision).toBe('park');
    expect(() => validateDecision({ decision: 'maybe' }, items)).toThrow();
    expect(emOutcome('park')).toBe('parked');
  });
});

describe('decide', () => {
  it('one chat call with system prompt; parses fenced JSON; Jev guides', async () => {
    const calls: unknown[] = [];
    const r = await decide(entity, items, handoff(), {
      llm: async (m) => { calls.push(m); return '```json\n{"decision":"duplicate","reason":"same","duplicate_of":"0190-item-1"}\n```'; },
      jev: async () => ({ choice: 'duplicate', probabilities: { duplicate: 0.8 } }),
    });
    expect(r).toMatchObject({ decision: 'duplicate', duplicate_of: '0190-item-1', jev: { choice: 'duplicate' } });
    expect(calls).toHaveLength(1);
    expect((calls[0] as { content: string }[])[0]!.content).toBe(SYSTEM_PROMPT);
  });
  it('bad JSON throws (worker em_fails it)', async () => {
    await expect(decide(entity, items, handoff(), { llm: async () => 'nope' })).rejects.toThrow();
  });
});
