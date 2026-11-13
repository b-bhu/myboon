import { describe, expect, it } from 'vitest';

import { canonicalUrl, decideIntake, intakeFeatures, intakeReason, replayIntake, type IntakeSignal } from './intake-filter.js';

const sig = (id: string, text: string | null, link: string | null = `https://ex.com/${id}`): IntakeSignal => ({ signal_id: id, text, link });
const verdict = (s: IntakeSignal, earlier: IntakeSignal[]) => decideIntake(intakeFeatures(s), earlier.map(intakeFeatures));

describe('#625 canonicalUrl', () => {
  it('drops tracking parameters, fragment, scheme, www and trailing slash', () => {
    const a = canonicalUrl('https://www.Example.com/news/a-story/?utm_source=x&utm_medium=y#top');
    expect(a).toBe('example.com/news/a-story');
    expect(canonicalUrl('http://example.com/news/a-story')).toBe(a);
    expect(canonicalUrl('https://example.com/news/a-story?fbclid=abc')).toBe(a);
  });
  it('keeps real query parameters and different paths apart', () => {
    expect(canonicalUrl('https://ex.com/p?id=1')).not.toBe(canonicalUrl('https://ex.com/p?id=2'));
    expect(canonicalUrl('https://ex.com/a')).not.toBe(canonicalUrl('https://ex.com/b'));
  });
  it('is null for no link or garbage', () => {
    expect(canonicalUrl(null)).toBeNull();
    expect(canonicalUrl('not a url')).toBeNull();
  });
});

describe('#625 decideIntake', () => {
  const first = sig('a', 'Trump Media posts $409.7 million Q3 profit as Bitcoin gains carry the quarter');

  it('url_dup: same page with different tracking parameters', () => {
    const v = verdict(sig('b', 'Trump Media Q3 profit story', 'https://ex.com/a?utm_source=tw'), [first]);
    expect(v).toMatchObject({ keep: false, rule: 'url_dup', match_signal_id: 'a' });
  });

  it('near_dup: an outlet-prefixed relay of the same headline', () => {
    const v = verdict(sig('b', 'COINTELEGRAPH: Trump Media posts $409.7 million Q3 profit as Bitcoin gains carry the quarter'), [first]);
    expect(v).toMatchObject({ keep: false, rule: 'near_dup', match_signal_id: 'a' });
    expect((v as { score: number }).score).toBeGreaterThanOrEqual(0.6);
  });

  it('same_event: a reworded headline with the same words and number', () => {
    const v = verdict(sig('b', 'Q3 profit of $409.7 million lifts Trump Media as Bitcoin carries quarter'), [first]);
    expect(v).toMatchObject({ keep: false, rule: 'same_event', match_signal_id: 'a' });
  });

  it('keeps a follow-up on the same topic with different facts (the 0.45-0.6 band)', () => {
    expect(verdict(sig('b', 'House blocks impeachment'), [sig('a', 'House to vote on impeachment')])).toEqual({ keep: true });
  });

  it('same words but no shared number is not same_event (only a close title match drops it)', () => {
    const v = verdict(sig('b', 'Inflation cools as Fed officials signal patience on rates'), [sig('a', 'Fed officials signal patience on rates as inflation cools')]);
    expect(v.keep ? 'keep' : (v as { rule: string }).rule).not.toBe('same_event');
  });

  it('same words but a different number is kept', () => {
    const v = verdict(sig('b', 'Q3 profit of $120.5 million lifts Trump Media as Bitcoin carries quarter'), [first]);
    expect(v).toEqual({ keep: true });
  });

  it('keeps an unrelated headline', () => {
    expect(verdict(sig('b', 'Enjin launches Governance 2.0 system'), [first])).toEqual({ keep: true });
  });

  it('low_content: empty, null, symbols only, or a single word', () => {
    for (const t of [null, '', '!!! ???', 'Bitcoin']) expect(verdict(sig('b', t), [first])).toMatchObject({ keep: false, rule: 'low_content', match_signal_id: null });
  });

  it('a richer headline that contains an earlier short one is kept (the new one adds a development)', () => {
    const short = sig('a', 'Bitcoin drops below $73,000');
    const rich = sig('b', 'FedWatch signals 100% chance of December rate hike, Bitcoin falls below $73,000');
    expect(verdict(rich, [short])).toEqual({ keep: true });
    // the other way round, the short repeat of the rich headline is dropped
    expect(verdict(sig('c', 'Bitcoin falls below $73,000 as FedWatch signals December rate hike'), [rich])).toMatchObject({ keep: false });
  });

  it('a CJK title is not low_content just because it is one unspaced word', () => {
    expect(verdict(sig('b', 'Coinbase获美国OCC正式颁发全国性信托牌照'), [first])).toEqual({ keep: true });
  });

  it('never matches itself', () => {
    expect(verdict(first, [first])).toEqual({ keep: true });
  });

  it('works for non-Latin titles (they are not all treated as empty)', () => {
    const ko = sig('a', '[안내] 홈페이지 접속 시 안내 문구 오류 및 정상화 안내', 'https://feed.bithumb.com/notice/1');
    const ko2 = sig('b', '[안내] 홈페이지 접속 시 안내 문구 오류 및 정상화 안내', 'https://feed.bithumb.com/notice/2');
    expect(verdict(ko2, [ko])).toMatchObject({ keep: false, rule: 'near_dup' });
  });

  it('intakeReason names the rule and the matched signal', () => {
    expect(intakeReason({ keep: false, rule: 'near_dup', match_signal_id: 'abc', score: 0.9 })).toBe('intake_filter:near_dup:abc');
    expect(intakeReason({ keep: false, rule: 'low_content', match_signal_id: null, score: null })).toBe('intake_filter:low_content');
  });
});

describe('#625 replayIntake', () => {
  const at = (h: number) => new Date(Date.UTC(2026, 10, 10, h)).toISOString();
  it('compares only with earlier kept signals in the last 24 hours', () => {
    const rows = [
      { ...sig('a', 'Hedge funds unwind Bitcoin basis trade as CME net shorts fall 89%'), created_at: at(0) },
      { ...sig('b', 'Hedge funds unwind Bitcoin basis trade as CME net shorts fall 89%'), created_at: at(2) },
      { ...sig('c', 'Hedge funds unwind Bitcoin basis trade as CME net shorts fall 89%'), created_at: at(3) },
    ];
    const r = replayIntake(rows);
    expect(r.map((x) => x.verdict.keep)).toEqual([true, false, false]);
    expect((r[2]!.verdict as { match_signal_id: string }).match_signal_id).toBe('a');
  });
  it('a repeat after more than 24 hours is kept', () => {
    const t = 'Hedge funds unwind Bitcoin basis trade as CME net shorts fall 89%';
    const r = replayIntake([{ ...sig('a', t), created_at: at(0) }, { ...sig('b', t), created_at: new Date(Date.UTC(2026, 10, 11, 1)).toISOString() }]);
    expect(r.map((x) => x.verdict.keep)).toEqual([true, true]);
  });
});
