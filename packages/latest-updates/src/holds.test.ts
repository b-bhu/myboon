/** #671: repeat_previous, stale_timeframe and the tighter watch check, on the write bar and through the runner. */
import { describe, expect, it } from 'vitest';

import { checkRepeatPrevious, checkWatchTied, runWriteBar } from './checks.js';
import { loadRunConfig } from './config.js';
import { bundle, draft, item, passingCase, publishedLast, uuid } from './fixtures.js';
import { runOnce } from './runner.js';
import type { Candidate, DecisionWrite, Store, WriteResult } from './store.js';
import { checkStaleTimeframe } from './timeframe.js';
import type { Bundle, Draft, LastUpdate } from './types.js';

const checks = (d: Draft, b: Bundle) => runWriteBar(d, b).map((f) => f.check);

/** The last card a repeat would copy: same how_we_got_here and watch line as the passing draft. */
const lastCard = (): LastUpdate => publishedLast({
  title: 'Bitcoin ranges between $78,000 and $87,000',
  what_happened: 'A quiet range with spot ETF flows mixed.',
  how_we_got_here: 'Spot funds have seen steady selling through the week.',
  what_to_watch: 'Watch the Dec 10 Fed decision and whether $74,000 holds.',
});

describe('repeat_previous', () => {
  it('holds a draft that restates the last card with only a new fact in what_happened', () => {
    const { bundle: b, draft: d } = passingCase();
    const withLast = { ...b, last_update: lastCard() };
    const failures = runWriteBar(d, withLast);
    expect(failures.map((f) => f.check)).toEqual(['repeat_previous', 'repeat_previous']);
    expect(failures.map((f) => f.detail)).toEqual(['how_we_got_here repeats the last card', 'what_to_watch repeats the last card']);
  });

  it('a reworded restatement (same words, new order) is still a repeat', () => {
    const { bundle: b, draft: d } = passingCase();
    const withLast = { ...b, last_update: lastCard() };
    const f = checkRepeatPrevious({ ...d, how_we_got_here: 'Through the week, spot funds have seen steady selling.', what_to_watch: 'Watch the Jan 28 FOMC meeting.' }, withLast);
    expect(f.map((x) => x.detail)).toEqual(['how_we_got_here repeats the last card']);
  });

  it('a reused phrase that adds a new level from the new items passes', () => {
    const { bundle: b, draft: d } = passingCase();
    const newItem = { ...b.new_items[0]!, summary: `${b.new_items[0]!.summary} Traders now watch $72,000.` };
    const withLast = { ...b, new_items: [newItem], last_update: lastCard() };
    const f = checkRepeatPrevious({ ...d, how_we_got_here: 'IBIT led the exit as outflows doubled.', what_to_watch: 'Watch the Dec 10 Fed decision and whether $72,000 holds.' }, withLast);
    expect(f).toEqual([]);
  });

  it('does not fire without a published or dark last card (null or an earlier item)', () => {
    const { bundle: b, draft: d } = passingCase();
    expect(b.last_update!.kind).toBe('earlier_item');
    const stand_in = { ...b, last_update: { ...b.last_update!, text: `${b.last_update!.text}\n${d.how_we_got_here}\n${d.what_to_watch}` } };
    expect(checks(d, stand_in)).toEqual([]);
    expect(checks(d, { ...b, last_update: null })).toEqual([]);
  });
});

describe('stale_timeframe', () => {
  const monday = (now: string) => {
    const { bundle: b, draft: d } = passingCase();
    return checkStaleTimeframe({ ...d, what_happened: `${d.what_happened} Stocks fell in Monday's session.` }, { ...b, now });
  };

  it('holds "Monday\'s session" once that Monday\'s 16:00 New York close has passed', () => {
    expect(monday('2026-11-16T21:00:00.000Z').map((f) => f.check)).toEqual(['stale_timeframe']); // Mon 16:00 EST
    expect(monday('2026-11-17T05:07:00.000Z').map((f) => f.check)).toEqual(['stale_timeframe']); // Tue
    expect(monday('2026-11-14T08:00:00.000Z').map((f) => f.check)).toEqual(['stale_timeframe']); // Sat: last Monday closed
  });

  it('passes the same wording while that Monday session is still open', () => {
    expect(monday('2026-11-16T15:00:00.000Z')).toEqual([]); // Mon 10:00 EST
    expect(monday('2026-11-16T20:59:00.000Z')).toEqual([]); // Mon 15:59 EST
  });

  it('"next Monday\'s open" looks forward and is not stale', () => {
    const { bundle: b, draft: d } = passingCase();
    expect(checkStaleTimeframe({ ...d, what_to_watch: "Watch next Monday's open." }, b)).toEqual([]);
  });

  it('"today" needs a new item on now\'s IST day; "yesterday" the IST day before', () => {
    const b = bundle({ new_items: [item({ title: 'x', occurred_at: '2026-11-14T06:00:00.000Z' })] }); // 11:30 IST, 14 Nov
    const today = draft({ what_happened: 'ETF outflows hit $2.1 billion today.' });
    const yesterday = draft({ what_happened: 'ETF outflows hit $2.1 billion yesterday.' });
    expect(checkStaleTimeframe(today, { ...b, now: '2026-11-14T08:00:00.000Z' })).toEqual([]); // 13:30 IST, 14 Nov
    expect(checkStaleTimeframe(today, { ...b, now: '2026-11-14T19:00:00.000Z' }).map((f) => f.check)).toEqual(['stale_timeframe']); // 00:30 IST, 15 Nov
    expect(checkStaleTimeframe(yesterday, { ...b, now: '2026-11-14T19:00:00.000Z' })).toEqual([]);
    expect(checkStaleTimeframe(yesterday, { ...b, now: '2026-11-14T08:00:00.000Z' }).map((f) => f.check)).toEqual(['stale_timeframe']);
  });

  it('"this week" needs a new item in now\'s ISO week (IST)', () => {
    const b = bundle({ new_items: [item({ title: 'x', occurred_at: '2026-11-14T06:00:00.000Z' })] }); // Sat 14 Nov, week 46
    const d = draft({ how_we_got_here: 'Spot funds kept selling this week.' });
    expect(checkStaleTimeframe(d, { ...b, now: '2026-11-15T10:00:00.000Z' })).toEqual([]); // Sun 15 Nov, week 46
    expect(checkStaleTimeframe(d, { ...b, now: '2026-11-16T05:00:00.000Z' }).map((f) => f.check)).toEqual(['stale_timeframe']); // Mon 16 Nov, week 47
  });

  it('the passing draft has no relative time words and clears the check', () => {
    const { bundle: b, draft: d } = passingCase();
    expect(checkStaleTimeframe(d, b)).toEqual([]);
  });
});

describe('watch tied to the new items', () => {
  it('holds a watch line whose only concrete level comes from the last card', () => {
    const { bundle: b, draft: d } = passingCase();
    const withLast = { ...b, last_update: publishedLast({ title: 'Bitcoin steadies', what_happened: 'Bitcoin held $81,500.', how_we_got_here: 'Range trade.', what_to_watch: 'Traders eye the SEC ruling on staking and the $81,500 level.' }) };
    const failures = runWriteBar({ ...d, what_to_watch: 'Watch whether $81,500 holds into the weekend.' }, withLast);
    expect(failures.map((f) => f.check)).toEqual(['watch']);
    expect(failures[0]!.detail).toBe('what_to_watch names no date, level or decision from the new items or their origin signals');
  });

  it('the entity\'s own name does not tie a watch line to the new items', () => {
    const { bundle: b, draft: d } = passingCase();
    expect(checkWatchTied({ ...d, what_to_watch: 'Watch whether Bitcoin reacts on Friday.' }, b).map((f) => f.check)).toEqual(['watch']);
  });

  it('a level from an origin signal of a new item ties the watch line', () => {
    const { bundle: b, draft: d } = passingCase();
    expect(checkWatchTied({ ...d, what_to_watch: 'Watch whether $74,000 support holds.' }, b)).toEqual([]);
  });

  it('a watch line with nothing concrete still fails once, with the old detail', () => {
    const { bundle: b, draft: d } = passingCase();
    expect(runWriteBar({ ...d, what_to_watch: 'Watch how the market reacts.' }, b)).toEqual([{ check: 'watch', detail: 'what_to_watch names no concrete date, price level or decision' }]);
  });
});

describe('through the runner (model mocked)', () => {
  const cand = (): Candidate => ({ entityId: uuid(), slug: 'bitcoin', newestItemId: uuid(), newestOccurredAt: '2026-11-14T06:00:00Z', errorCount: 0 });
  const setup = (c: Candidate, over: Partial<Bundle> = {}) => {
    const writes: DecisionWrite[] = [];
    const store: Store = {
      async listCandidates() { return [c]; },
      async loadBundle(): Promise<Bundle> {
        const { bundle: b } = passingCase();
        return { ...b, newest_item_id: c.newestItemId, new_items: [{ ...b.new_items[0]!, id: c.newestItemId }], ...over };
      },
      async record(w): Promise<WriteResult> { writes.push(w); return { outcome: 'written', decision: w.decision, attempt: 1 }; },
    };
    return { store, writes };
  };
  const write = (c: Candidate, over: Partial<Draft> = {}) => async () => JSON.stringify({
    decision: 'write', reason: 'new number', ...passingCase().draft,
    claims: [{ text: 'ETF outflow of $2.1 billion', source_item_id: c.newestItemId, source_signal_id: null }], ...over,
  });
  const config = loadRunConfig({});

  it('a restated last card is a hold with reason repeat_previous and nothing published', async () => {
    const c = cand();
    const { store, writes } = setup(c, { last_update: lastCard() });
    const s = await runOnce({ store, llm: write(c), config, log: () => {} });
    expect(s).toMatchObject({ hold: 1, published: 0 });
    expect(writes[0]).toMatchObject({ decision: 'hold', reason: 'write bar failed: repeat_previous' });
    expect(writes[0]!.publish).toBeUndefined();
    expect(writes[0]!.checkFailures).toHaveLength(2);
  });

  it('a closed "Monday\'s session" is a hold with reason stale_timeframe', async () => {
    const c = cand();
    const { store, writes } = setup(c, { now: '2026-11-17T05:07:00.000Z' });
    const d = passingCase().draft;
    await runOnce({ store, llm: write(c, { what_happened: `${d.what_happened} Stocks fell in Monday's session.` }), config, log: () => {} });
    expect(writes[0]).toMatchObject({ decision: 'hold', reason: 'write bar failed: stale_timeframe' });
    expect(writes[0]!.publish).toBeUndefined();
  });

  it('both new reasons are listed together, in the countable format', async () => {
    const c = cand();
    const { store, writes } = setup(c, { last_update: lastCard(), now: '2026-11-17T05:07:00.000Z' });
    const d = passingCase().draft;
    await runOnce({ store, llm: write(c, { what_happened: `${d.what_happened} Stocks fell in Monday's session.` }), config, log: () => {} });
    expect(writes[0]!.reason).toBe('write bar failed: repeat_previous, stale_timeframe');
  });

  it('the passing case still publishes dark with no new check firing (with and without a last card)', async () => {
    for (const last of [undefined, null]) {
      const c = cand();
      const { store, writes } = setup(c, last === null ? { last_update: null } : {});
      const s = await runOnce({ store, llm: write(c), config, log: () => {} });
      expect(s.published).toBe(1);
      expect(writes[0]).toMatchObject({ decision: 'published', checkFailures: [] });
      expect(writes[0]!.publish!.visibility).toBe('dark');
    }
  });
});
