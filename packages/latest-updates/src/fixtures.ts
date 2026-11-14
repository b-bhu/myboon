/** Test fixtures (not shipped code): small builders for bundles and drafts. */
import type { Bundle, Draft, Item, Signal } from './types.js';

let n = 0;
export const uuid = (): string => {
  n += 1;
  return `01a1d000-0000-7000-8000-${String(n).padStart(12, '0')}`;
};

export function item(over: Partial<Item> & { title: string }): Item {
  return {
    id: uuid(), summary: null, note: null, angle: null, occurred_at: '2026-11-14T06:00:00.000Z', created_at: '2026-11-14T06:05:00.000Z', signal_id: null,
    ...over,
  };
}

export function signal(over: Partial<Signal> & { signal_id: string }): Signal {
  return { type: 'news', source: 'tokens_xyz', text: null, excerpt: null, numbers: {}, link: null, occurred_at: null, created_at: null, ...over };
}

export function bundle(over: Partial<Bundle> & { new_items: Item[] }): Bundle {
  const newest = over.new_items[0]!;
  return {
    entity: { id: uuid(), slug: 'bitcoin', name: 'Bitcoin', type: 'asset', summary: null },
    newest_item_id: newest.id,
    prior_items: [],
    origin_signals: [],
    last_update: null,
    ...over,
  };
}

export function draft(over: Partial<Draft> = {}): Draft {
  return {
    title: 'Bitcoin slips as ETF outflows grow',
    what_happened: 'Bitcoin fell below $75,000 as ETF outflows reached $2.1 billion, with IBIT driving 78% of the exit.',
    how_we_got_here: 'Spot funds have seen steady selling through the week.',
    what_to_watch: 'Watch the Dec 10 Fed decision and whether $74,000 holds.',
    claims: [],
    ...over,
  };
}

/** A bundle for which `draft()` passes the whole write bar, plus the claim ids to cite. */
export function passingCase(): { bundle: Bundle; draft: Draft } {
  const a = item({
    title: 'Bitcoin slips below $75,000 as IBIT drives 78% of a $2.1 billion ETF outflow wave',
    summary: 'BTC has lost the $75,000 level as the ETF sell-off swelled to $2.1 billion, with IBIT alone accounting for 78% of the withdrawals ahead of the Dec 10 Fed decision.',
    signal_id: 'a'.repeat(64),
  });
  const last = item({ title: 'Bitcoin ranges between $78,000 and $87,000', summary: 'A quiet range with spot ETF flows mixed.' });
  const b = bundle({
    new_items: [a],
    prior_items: [last],
    origin_signals: [signal({ signal_id: 'a'.repeat(64), text: 'Bitcoin slips below $75,000 as ETF outflows hit $2.1 billion; IBIT 78%; $74,000 support in focus' })],
    last_update: { kind: 'earlier_item', id: last.id, title: last.title, date: last.occurred_at, text: 'Bitcoin ranges between $78,000 and $87,000\nA quiet range with spot ETF flows mixed.' },
  });
  const d = draft({ claims: [{ text: 'ETF outflow of $2.1 billion', source_item_id: a.id, source_signal_id: null }] });
  return { bundle: b, draft: d };
}
