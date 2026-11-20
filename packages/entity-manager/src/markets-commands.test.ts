/** #690 the backfill commands, no database: preview select-only + apply parse/validate/plan. */
import type pg from 'pg';
import { describe, expect, it } from 'vitest';

import { parseApplyFile, planApply, planLine, runApply, validateApplyFile, type ApplyEntry } from './markets-apply.js';
import { previewTable, runPreview, stubMarketsLlm, type PreviewEntry } from './markets-preview.js';
import type { Q } from './markets-worker.js';

type Call = { sql: string; params: unknown[] };

/** A recording pool answering each read by its SQL shape, plus an optional transaction client. */
function fakeDb(opts: {
  candidates?: Array<{ id: string; slug: string; name: string; type: string; summary: string | null }>;
  items?: unknown[];
  slugs?: Array<{ id: string; slug: string; name: string; type: string; summary: string | null }>;
  entities?: Record<string, { slug: string; markets_checked_at: Date | null }>;
  pinned?: Array<{ rank: number; symbol: string }>;
  /** with a transaction client: what the check reads, so --yes writes can be exercised */
  tx?: { exists: boolean; checked: Date | null; pinned?: Array<{ rank: number; symbol: string }> };
} = {}) {
  const calls: Call[] = [];
  const txCalls: Call[] = [];
  const pool = {
    async query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[] }> {
      calls.push({ sql, params });
      if (sql.includes('coalesce(occurred_at, created_at)')) return { rows: opts.items ?? [] };
      if (sql.includes('atlas.entity_markets')) return { rows: opts.pinned ?? [] };
      if (sql.includes('slug = any')) return { rows: opts.slugs ?? [] };
      if (sql.includes('from atlas.entities e')) return { rows: opts.candidates ?? [] };
      if (sql.includes('from atlas.entities')) {
        const e = opts.entities?.[String(params[0] ?? '')];
        return { rows: e ? [{ slug: e.slug, markets_checked_at: e.markets_checked_at }] : [] };
      }
      return { rows: [] };
    },
    async connect() {
      return {
        async query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount?: number }> {
          txCalls.push({ sql, params });
          if (sql.includes('for update')) return { rows: opts.tx!.exists ? [{ markets_checked_at: opts.tx!.checked }] : [] };
          if (sql.includes('entity_markets where entity_id')) return { rows: opts.tx!.pinned ?? [] };
          return { rows: [], rowCount: 1 };
        },
        release() {},
      };
    },
  };
  const writes = (all: Call[]) => all.filter((c) => /\b(insert into|update atlas|delete from|(^| )begin( |$)|rollback|commit)/i.test(c.sql));
  return { db: pool as unknown as pg.Pool & Q, calls, txCalls, clean: () => writes(calls), dirty: () => writes(txCalls) };
}
const LLM = (reply: string) => async () => reply;

describe('#690 markets:preview', () => {
  it('runs the pick logic, shapes the preview entries and issues no write SQL', async () => {
    const { db, calls, clean } = fakeDb({ candidates: [{ id: 'e1', slug: 'bitcoin', name: 'Bitcoin', type: 'asset', summary: null }] });
    const entries = await runPreview({ db, llm: LLM('{"markets":[{"symbol":"BTC","reason":"moves core BTC"},{"symbol":"NOTLIVE","reason":null}]}'), limit: 50, list: async () => new Set(['BTC', 'ETH']) });
    expect(entries).toEqual([{ slug: 'bitcoin', entityId: 'e1', markets: [{ symbol: 'BTC', reason: 'moves core BTC', setBy: 'model', pinned: false }] }]);
    expect(entries[0]!.markets[0]).toMatchObject({ symbol: 'BTC', setBy: 'model', pinned: false });
    expect(clean()).toEqual([]);
    expect(calls.every((c) => c.sql.trim().toLowerCase().startsWith('select'))).toBe(true);
  });

  it('--slugs overrides the candidate query; the JSON file shape carries slug, entityId and markets', async () => {
    const { db, calls } = fakeDb({ slugs: [{ id: 'e2', slug: 'oil', name: 'Oil', type: 'topic', summary: null }] });
    const entries = await runPreview({ db, llm: stubMarketsLlm, limit: 7, slugs: ['oil', 'gone'], list: async () => new Set(['BTC']) });
    // the slugs call is a select by slug, not the candidate query
    expect(calls[0]!.sql).toContain('slug = any');
    expect(entries[0]!.slug).toBe('oil');
    const parsed = JSON.parse(JSON.stringify(entries)) as Array<Record<string, unknown>>;
    expect(Array.isArray(parsed)).toBe(true);
    expect(Object.keys(parsed[0]!).sort()).toEqual(['entityId', 'markets', 'slug']);
  });

  it('the printed table uses slug rank symbol reason and "none" for zero picks', () => {
    const entries: PreviewEntry[] = [
      { slug: 'a', entityId: 'e1', markets: [{ symbol: 'BTC', reason: 'core', setBy: 'model', pinned: false }] },
      { slug: 'b', entityId: 'e2', markets: [] },
    ];
    expect(previewTable(entries)).toEqual(['a\t1\tBTC\tcore', 'b\tnone']);
  });
});

describe('#690 markets:apply — parse and validate', () => {
  const file = JSON.stringify([{ slug: 'a', entityId: 'e1', markets: [{ symbol: 'BTC', reason: 'r', setBy: 'model', pinned: false }] }]);

  it('parses a reviewed preview file', () => {
    expect(parseApplyFile(file)).toEqual([{ slug: 'a', entityId: 'e1', markets: [{ symbol: 'BTC', reason: 'r', setBy: 'model', pinned: false }] }]);
  });

  it('refuses files that are not the contract: not an array, no slug/entityId, bad setBy, no markets array', () => {
    for (const bad of ['{}', '[{"slug":"a","markets":[]}]', '[{"entityId":"e1","markets":[]}]', '[{"slug":"a","entityId":"e1","markets":[{"symbol":"BTC","setBy":"who"}]}]', '[{"slug":"a","entityId":"e1","markets":"BTC"}]']) {
      expect(() => parseApplyFile(bad)).toThrow();
    }
  });

  it('the whole file is refused when any symbol is unknown, repeated, or an entity has more than 3', () => {
    const L = new Set(['BTC', 'ETH']);
    expect(() => validateApplyFile(parseApplyFile('[{"slug":"a","entityId":"e1","markets":[{"symbol":"BTC","setBy":"model","pinned":false},{"symbol":"X1","setBy":"model","pinned":false}]}]'), L)).toThrow(/X1.*not on the live Hyperliquid list; refusing the whole file/);
    expect(() => validateApplyFile(parseApplyFile('[{"slug":"a","entityId":"e1","markets":[{"symbol":"BTC","setBy":"model"},{"symbol":"BTC","setBy":"manual"}]}]') as ApplyEntry[], L)).toThrow(/repeats/);
    expect(() => validateApplyFile([{ slug: 'a', entityId: 'e1', markets: Array.from({ length: 4 }, (_, i) => ({ symbol: 'BTC', reason: null, setBy: 'model' as const, pinned: false })) }], L)).toThrow(/at most 3/);
    // pinned true and manual setBy are accepted when they are valid
    expect(() => validateApplyFile(parseApplyFile(file), L)).not.toThrow();
  });

  it('pinned defaults to false and the reason is re-normalised against the DB bounds', () => {
    const parsed = parseApplyFile('[{"slug":"a","entityId":"e1","markets":[{"symbol":"BTC","setBy":"manual"},{"symbol":"ETH","setBy":"model","pinned":true,"reason":"a\\nb c\\n"}]}]');
    expect(parsed[0]!.markets[0]).toMatchObject({ pinned: false, reason: null });
    expect(parsed[0]!.markets[1]).toMatchObject({ pinned: true, reason: 'a b c' });
  });
});

describe('#690 markets:apply — the plan (no --yes)', () => {
  it('prints planned ranks from the pinned rows and issues no write SQL', async () => {
    const { db, clean } = fakeDb({
      entities: { e1: { slug: 'a', markets_checked_at: null } },
      pinned: [{ rank: 1, symbol: 'xyz:GOLD' }],
    });
    const entries = parseApplyFile('[{"slug":"a","entityId":"e1","markets":[{"symbol":"BTC","setBy":"model"},{"symbol":"ETH","setBy":"manual","pinned":true}]}]');
    const plan = await planApply(db, entries);
    expect(plan).toEqual([{ slug: 'a', kind: 'write', rows: [{ rank: 2, symbol: 'BTC', setBy: 'model', pinned: false }, { rank: 3, symbol: 'ETH', setBy: 'manual', pinned: true }] }]);
    expect(planLine(plan[0]!)).toContain('rank 2 BTC (set_by model, pinned false)');
    expect(clean()).toEqual([]);
  });

  it('an already checked entity is reported as skipped, an unknown id as refused', async () => {
    const { db } = fakeDb({ entities: { e1: { slug: 'a', markets_checked_at: new Date() } } });
    const plan = await planApply(db, [{ slug: 'a', entityId: 'e1', markets: [{ symbol: 'BTC', reason: null, setBy: 'model', pinned: false }] }]);
    expect(plan).toEqual([{ slug: 'a', kind: 'skip', why: 'already checked' }]);
    expect(planLine(plan[0]!)).toBe('a: skipped: already checked');

    const { db: db2 } = fakeDb({});
    const plan2 = await planApply(db2, [{ slug: 'a', entityId: 'nope', markets: [] }]);
    expect(plan2).toEqual([{ slug: 'a', kind: 'missing' }]);
  });

  it('without --yes the flow stops after the plan and never writes', async () => {
    const { db, clean, dirty } = fakeDb({ entities: { e1: { slug: 'a', markets_checked_at: null } } });
    const log: string[] = [];
    const refused = await runApply({
      db,
      entries: [{ slug: 'a', entityId: 'e1', markets: [{ symbol: 'BTC', reason: 'core', setBy: 'model', pinned: false }] }],
      yes: false,
      list: async () => new Set(['BTC']),
      log: (l) => log.push(l),
    });
    expect(refused).toBe(0);
    expect(clean()).toEqual([]);
    expect(dirty()).toEqual([]);
    expect(log.join('\n')).toContain('rank 1 BTC');
    expect(log.join('\n')).toContain('nothing was written; pass --yes to write these rows');
  });

  it('with --yes the writes go through the writeMarkets transaction and a refused entity exits non-zero', async () => {
    const { db, dirty } = fakeDb({ entities: { e1: { slug: 'a', markets_checked_at: null } }, tx: { exists: true, checked: null } });
    const log: string[] = [];
    const refused = await runApply({
      db,
      entries: [
        { slug: 'a', entityId: 'e1', markets: [{ symbol: 'BTC', reason: 'r', setBy: 'model', pinned: false }] },
        { slug: 'b', entityId: 'gone', markets: [] },
      ],
      yes: true,
      list: async () => new Set(['BTC']),
      log: (l) => log.push(l),
    });
    expect(refused).toBe(1);
    expect(log.join('\n')).toContain('a: wrote 1 row(s)');
    expect(log.join('\n')).toContain('b: not found');
    expect(dirty().some((c) => c.sql.includes('insert into atlas.entity_markets'))).toBe(true);
    expect(dirty().some((c) => c.sql.includes('markets_checked_at = now()'))).toBe(true);
  });
});
