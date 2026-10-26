/** #479: StoryCase (v1) and StoryOutcome zod schemas -- the Story stage's wire contract. */
import { describe, expect, it } from 'vitest';

import { parseStoryCase, parseStoryOutcome, STORY_OUTCOMES, storyCaseSchema, storyOutcomeSchema } from './story.js';

const caseWith = (over: Record<string, unknown>) =>
  parseStoryCase({
    state: {
      signal: { signal_id: 's-xrp', text: 'SEC files new brief in Ripple XRP appeal', excerpt: null, occurred_at: '2026-10-26T09:00:00.000Z' },
      candidates: [
        {
          slug: 'xrp',
          name: 'XRP',
          type: 'asset',
          items: [
            { id: '01890a5d-ac96-774b-bcce-b302099a8057', title: 'SEC appeal in Ripple case', summary: null, occurred_at: '2026-10-05T09:00:00.000Z' },
          ],
        },
      ],
    },
    questions: {
      entity: { type: 'choice', instructions: 'Which candidate is this signal mainly about?', criteria: { xrp: 'XRP' } },
      item: {
        type: 'choice',
        instructions: 'Which item does the signal update?',
        criteria: { '01890a5d-ac96-774b-bcce-b302099a8057': 'SEC appeal', new_story: 'starts something new', adds_nothing: 'adds nothing' },
      },
    },
    ...over,
  });

describe('StoryCase v1', () => {
  it('accepts a real-shaped linker case and round-trips its fields', () => {
    const parsed = caseWith({});
    expect(parsed.state.candidates[0]?.slug).toBe('xrp');
    expect(parsed.state.candidates[0]?.items[0]?.title).toBe('SEC appeal in Ripple case');
    expect(parsed.questions.item.criteria.new_story).toBe('starts something new');
  });

  it('allows a null excerpt, summary and occurred_at (atlas columns are nullable)', () => {
    const parsed = caseWith({
      state: {
        signal: { signal_id: 's-2', text: null, excerpt: null, occurred_at: null },
        candidates: [{ slug: 'xrp', name: 'XRP', type: 'asset', items: [] }],
      },
    });
    expect(parsed.state.signal.text).toBeNull();
    expect(parsed.state.candidates[0]?.items).toEqual([]);
  });

  it('rejects more than five candidates or items per candidate (linker caps)', () => {
    const tooManyCandidates = Array.from({ length: 6 }, (_, i) => ({ slug: `c${i}`, name: `c${i}`, type: 'asset', items: [] }));
    expect(() => caseWith({ state: { signal: { signal_id: 's', text: null, excerpt: null, occurred_at: null }, candidates: tooManyCandidates } })).toThrow();
    const tooManyItems = Array.from({ length: 6 }, (_, i) => ({
      id: '01890a5d-ac96-774b-bcce-b302099a8057', title: `t${i}`, summary: null, occurred_at: null,
    }));
    expect(() =>
      caseWith({
        state: {
          signal: { signal_id: 's', text: null, excerpt: null, occurred_at: null },
          candidates: [{ slug: 'xrp', name: 'XRP', type: 'asset', items: tooManyItems }],
        },
      }))
      .toThrow();
  });

  it('rejects a per-call question that is not a choice question', () => {
    const broken = caseWith({});
    (broken.questions.entity as { type: string }).type = 'noul';
    expect(() => storyCaseSchema.parse(broken)).toThrow();
  });
});

describe('StoryOutcome', () => {
  it('accepts every outcome kind', () => {
    expect(parseStoryOutcome({ outcome: 'linked', slug: 'xrp', item_id: '01890a5d-ac96-774b-bcce-b302099a8057', probabilities: { entity_p: 0.95, entity_margin: 0.9, item_p: 0.8, item_margin: 0.5 } }).outcome).toBe('linked');
    expect(parseStoryOutcome({ outcome: 'new_story', slug: 'xrp', probabilities: { entity_p: 0.95, entity_margin: 0.9, item_p: 0.8, item_margin: 0.5 } }).outcome).toBe('new_story');
    expect(parseStoryOutcome({ outcome: 'parked', park_reason: 'below_cutoff: entity p=0.80 margin=0.75' })).toMatchObject({ outcome: 'parked' });
    expect(parseStoryOutcome({ outcome: 'failed', error: 'jev 503' })).toMatchObject({ outcome: 'failed' });
    expect(STORY_OUTCOMES).toHaveLength(storyOutcomeSchema.options.length);
  });

  it('rejects a malformed outcome', () => {
    expect(() => parseStoryOutcome({ outcome: 'linked', slug: 'xrp', item_id: 'not-a-uuid' })).toThrow();
    expect(() => parseStoryOutcome({ outcome: 'new_story', slug: 'xrp' })).toThrow();
    expect(() => parseStoryOutcome({ outcome: 'new_story', slug: 'xrp', probabilities: { entity_p: 1.2, entity_margin: 0.9, item_p: 0.8, item_margin: 0.5 } })).toThrow();
    expect(() => parseStoryOutcome({ outcome: 'parked' })).toThrow();
    expect(() => parseStoryOutcome({ outcome: 'unknown' })).toThrow();
  });
});