/**
 * #690 the DB-facing side of the entity markets pass: load the unchecked candidates, ask the model
 * per entity, write the links under the checked-once rule, all via the entity_worker grants
 * (entities id/slug/name/type/summary/status/markets_checked_at, entity_items, entity_markets).
 * A markets failure never fails the run and never calls em_fail: an entity that could not be
 * decided or written keeps markets_checked_at null, so the next run retries it.
 */
import type pg from 'pg';

import type { Llm } from './clients.js';
import { parseJsonReply, type RecentItem } from './decide.js';
import { fetchHyperliquidMarkets } from './hyperliquid.js';
import {
  MARKETS_SYSTEM_PROMPT,
  marketsUserMessage,
  validateMarkets,
  type MarketPick,
  MAX_MARKET_PICKS,
} from './markets.js';
import { loadRecentItems } from './worker.js';

export type Q = Pick<pg.PoolClient, 'query'>;
export type MarketCandidate = { id: string; slug: string; name: string; type: string; summary: string | null };

/** One link to write: set_by/pinned come from the pass ('model', false) or from the reviewed file. */
export type MarketRow = { symbol: string; reason: string | null; setBy: 'model' | 'manual'; pinned: boolean };

/** Pass line counters: linked = entities with >=1 pick; none = checked, zero picks; retry = left unchecked. */
export type MarketsPassSummary = { checked: number; linked: number; none: number; retry: number };

/** #690 candidates: active, never checked, one item in the last 7 days, newest such item first. */
export async function loadMarketCandidates(db: Q, limit: number): Promise<MarketCandidate[]> {
  const r = await db.query<MarketCandidate>(
    `select e.id, e.slug, e.name, e.type, e.summary
       from atlas.entities e
      where e.status = 'active' and e.markets_checked_at is null
        and exists (
          select 1 from atlas.entity_items i
           where i.main_entity_id = e.id and i.status = 'active'
             and i.occurred_at >= now() - interval '7 days')
      order by (select max(i2.occurred_at) from atlas.entity_items i2
                 where i2.main_entity_id = e.id and i2.status = 'active'
                   and i2.occurred_at >= now() - interval '7 days') desc, e.id desc
      limit $1`,
    [limit],
  );
  return r.rows;
}

export type PickMarketsDeps = { llm: Llm; items: RecentItem[]; symbols: ReadonlySet<string> };

/** One model call per entity: MARKETS_SYSTEM_PROMPT + the user message, parsed and validated. */
export async function pickMarkets(
  entity: MarketCandidate,
  deps: PickMarketsDeps,
): Promise<{ picks: MarketPick[]; dropped: string[] }> {
  const raw = await deps.llm([
    { role: 'system', content: MARKETS_SYSTEM_PROMPT },
    { role: 'user', content: marketsUserMessage(entity, deps.items, [...deps.symbols]) },
  ]);
  return validateMarkets(parseJsonReply(raw), deps.symbols);
}

/**
 * Fill the free ranks 1..3 in `rows` order around the ranks the pinned rows keep, skipping rows
 * whose symbol is already pinned. Pure: writeMarkets uses it in the transaction, the apply script
 * uses it for the printed plan, so both agree on the exact rows and ranks.
 */
export function assignMarketRanks(
  rows: MarketRow[],
  pinnedRows: Array<{ rank: number; symbol: string }>,
): Array<{ rank: number; row: MarketRow }> {
  const usedSymbols = new Set(pinnedRows.map((r) => r.symbol));
  const usedRanks = new Set(pinnedRows.map((r) => Number(r.rank)));
  const out: Array<{ rank: number; row: MarketRow }> = [];
  for (const row of rows) {
    if (usedSymbols.has(row.symbol)) continue;
    let rank: number | null = null;
    for (let n = 1; n <= MAX_MARKET_PICKS; n++) {
      if (!usedRanks.has(n)) {
        rank = n;
        break;
      }
    }
    if (rank === null) break;
    usedSymbols.add(row.symbol);
    usedRanks.add(rank);
    out.push({ rank, row });
  }
  return out;
}

export type WriteMarketsResult = { outcome: 'written'; rows: number } | { outcome: 'skip' };

/**
 * One transaction per entity (#690): the checked-once rule under a row lock, pinned links kept,
 * unpinned ones replaced, new picks in the free ranks, then markets_checked_at = now(). Returns
 * 'skip' without writing anything when another run (or an apply while a run was going) checked
 * the entity first.
 */
export async function writeMarkets(db: pg.Pool, entityId: string, picks: MarketRow[]): Promise<WriteMarketsResult> {
  const client = await db.connect();
  try {
    await client.query('begin');
    const cur = await client.query<{ markets_checked_at: Date | null }>(
      'select markets_checked_at from atlas.entities where id = $1 for update',
      [entityId],
    );
    const row = cur.rows[0];
    if (!row) throw new Error(`entity ${entityId} not found`);
    if (row.markets_checked_at !== null) {
      await client.query('rollback');
      return { outcome: 'skip' };
    }
    const pinned = await client.query<{ rank: number; symbol: string }>(
      'select rank, symbol from atlas.entity_markets where entity_id = $1 and pinned = true order by rank',
      [entityId],
    );
    const assigned = assignMarketRanks(picks, pinned.rows);
    await client.query('delete from atlas.entity_markets where entity_id = $1 and pinned = false', [entityId]);
    for (const a of assigned) {
      await client.query(
        'insert into atlas.entity_markets (entity_id, rank, symbol, set_by, pinned, reason) values ($1, $2, $3, $4, $5, $6)',
        [entityId, a.rank, a.row.symbol, a.row.setBy, a.row.pinned, a.row.reason],
      );
    }
    await client.query('update atlas.entities set markets_checked_at = now() where id = $1', [entityId]);
    await client.query('commit');
    return { outcome: 'written', rows: assigned.length };
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export type MarketsPassDeps = {
  pool: pg.Pool;
  llm: Llm;
  limit: number;
  /** Injectable live list (tests); default fetchHyperliquidMarkets, cached 10 minutes in memory. */
  list?: () => Promise<ReadonlySet<string>>;
  log?: (e: Record<string, unknown>) => void;
};

/**
 * The whole pass over up to `limit` candidates. The live list is fetched first: if it throws the
 * pass is skipped with nothing written (skipped: "hyperliquid_down") — every entity stays
 * unchecked and the next run retries. One model failure or write failure per entity is logged and
 * counted as a retry, never calling em_fail, never failing the run.
 */
export async function runMarketsPass(deps: MarketsPassDeps): Promise<MarketsPassSummary> {
  const log = deps.log ?? ((e: Record<string, unknown>) => console.log(JSON.stringify(e)));
  const sum: MarketsPassSummary = { checked: 0, linked: 0, none: 0, retry: 0 };
  let symbols: ReadonlySet<string>;
  try {
    symbols = await (deps.list ?? (() => fetchHyperliquidMarkets()))();
  } catch {
    log({ event: 'em_markets', checked: 0, linked: 0, none: 0, retry: 0, skipped: 'hyperliquid_down' });
    return sum;
  }
  for (const entity of await loadMarketCandidates(deps.pool, deps.limit)) {
    sum.checked++;
    try {
      const items = await loadRecentItems(deps.pool, entity.id);
      const { picks, dropped } = await pickMarkets(entity, { llm: deps.llm, items, symbols });
      await writeMarkets(deps.pool, entity.id, picks.map((p): MarketRow => ({ ...p, setBy: 'model', pinned: false })));
      log({ event: 'em_markets_pick', entity: entity.slug, symbols: picks.map((p) => p.symbol), dropped });
      if (picks.length) sum.linked++;
      else sum.none++;
    } catch (e) {
      sum.retry++;
      log({ event: 'em_markets_retry', entity: entity.slug, error: (e instanceof Error ? e.message : String(e)).slice(0, 300) });
    }
  }
  log({ event: 'em_markets', checked: sum.checked, linked: sum.linked, none: sum.none, retry: sum.retry, skipped: null });
  return sum;
}
