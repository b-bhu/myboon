/**
 * #690 guided-backfill apply: writes exactly the reviewed rows of a markets:preview JSON file.
 * It re-validates every symbol against the live Hyperliquid list and refuses the whole file if
 * any is unknown, an entity has more than 3, or a symbol repeats. setBy ('model' or 'manual') and
 * pinned come from the file, so Bibhu edits picks before saving. Per entity the transaction is the
 * writeMarkets one: it writes only while markets_checked_at is still null and otherwise reports
 * "skipped: already checked". An entry whose markets list is empty still runs that transaction
 * (#696): zero rows, markets_checked_at set. Without --yes it only prints what it would write
 * (selects only).
 *
 * Usage: pnpm --filter @myboon/entity-manager markets:apply --file <json> [--yes]
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import pg from 'pg';

import { fetchHyperliquidMarkets } from './hyperliquid.js';
import { MAX_MARKET_PICKS, cleanMarketReason } from './markets.js';
import { assignMarketRanks, writeMarkets, type Q } from './markets-worker.js';
import { createPool } from './worker.js';

export type ApplyRow = { symbol: string; reason: string | null; setBy: 'model' | 'manual'; pinned: boolean };
export type ApplyEntry = { slug: string; entityId: string; markets: ApplyRow[] };

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/** Parse the preview JSON file; throws naming the entry when its shape is not the file contract. */
export function parseApplyFile(text: string): ApplyEntry[] {
  const v: unknown = JSON.parse(text);
  if (!Array.isArray(v)) throw new Error('the file must be an array of preview entries');
  return v.map((rawEntry, i): ApplyEntry => {
    const e = rec(rawEntry);
    const slug = str(e.slug);
    const entityId = str(e.entityId);
    if (!slug || !entityId) throw new Error(`entry ${i} is missing slug or entityId`);
    if (!Array.isArray(e.markets)) throw new Error(`entry ${i} (${slug}) has no markets array`);
    return {
      slug,
      entityId,
      markets: (e.markets as unknown[]).map((rawMarket, j): ApplyRow => {
        const m = rec(rawMarket);
        const symbol = str(m.symbol);
        if (!symbol) throw new Error(`entry ${i} (${slug}) market ${j} is missing symbol`);
        const setBy = str(m.setBy);
        if (setBy !== 'model' && setBy !== 'manual') throw new Error(`entry ${i} (${slug}) market ${j}: setBy must be "model" or "manual"`);
        if (m.pinned !== undefined && typeof m.pinned !== 'boolean') throw new Error(`entry ${i} (${slug}) market ${j}: pinned must be true or false`);
        return { symbol, reason: cleanMarketReason(m.reason), setBy, pinned: m.pinned === true };
      }),
    };
  });
}

/**
 * Re-validate a parsed file against the live symbol list: any unknown or repeated symbol, or more
 * than 3 markets for one entity, refuses the WHOLE file (nothing is written at all). Reasons were
 * already normalised by parse, so the DB checks can never reject a row.
 */
export function validateApplyFile(entries: ApplyEntry[], live: ReadonlySet<string>): void {
  for (const e of entries) {
    if (e.markets.length > MAX_MARKET_PICKS) throw new Error(`${e.slug}: ${e.markets.length} markets; refusing the whole file (at most 3 per entity)`);
    const seen = new Set<string>();
    for (const m of e.markets) {
      if (!live.has(m.symbol)) throw new Error(`${e.slug}: symbol ${JSON.stringify(m.symbol)} is not on the live Hyperliquid list; refusing the whole file`);
      if (seen.has(m.symbol)) throw new Error(`${e.slug}: symbol ${m.symbol} repeats; refusing the whole file`);
      seen.add(m.symbol);
    }
  }
}

export type ApplyPlanLine =
  | { slug: string; kind: 'write'; rows: Array<{ rank: number; symbol: string; setBy: string; pinned: boolean }> }
  | { slug: string; kind: 'empty_write' }
  | { slug: string; kind: 'skip'; why: string }
  | { slug: string; kind: 'nothing' }
  | { slug: string; kind: 'missing' }
  | { slug: string; kind: 'slug_mismatch' };

export function planLine(line: ApplyPlanLine): string {
  if (line.kind === 'write') {
    return `${line.slug}: ${line.rows.length} row(s): ${line.rows
      .map((r) => `rank ${r.rank} ${r.symbol} (set_by ${r.setBy}, pinned ${r.pinned})`)
      .join(', ')}`;
  }
  if (line.kind === 'skip') return `${line.slug}: skipped: ${line.why}`;
  if (line.kind === 'empty_write') return `${line.slug}: checked, no markets`;
  if (line.kind === 'nothing') return `${line.slug}: nothing to write (all picks pinned)`;
  if (line.kind === 'missing') return `${line.slug}: not found (no atlas.entities row with that entityId); refusing this entity`;
  return `${line.slug}: slug does not match the entity that id resolves to; refusing this entity`;
}

/** Read-only plan for printing (and the dry run): which rows would be written, or the skip reason. */
export async function planApply(db: Q, entries: ApplyEntry[]): Promise<ApplyPlanLine[]> {
  const out: ApplyPlanLine[] = [];
  for (const e of entries) {
    const r = await db.query<{ slug: string; markets_checked_at: Date | null }>(
      'select slug, markets_checked_at from atlas.entities where id = $1',
      [e.entityId],
    );
    const row = r.rows[0];
    if (!row) {
      out.push({ slug: e.slug, kind: 'missing' });
      continue;
    }
    if (row.slug !== e.slug) {
      out.push({ slug: e.slug, kind: 'slug_mismatch' });
      continue;
    }
    if (row.markets_checked_at !== null) {
      out.push({ slug: e.slug, kind: 'skip', why: 'already checked' });
      continue;
    }
    const pinned = await db.query<{ rank: number; symbol: string }>(
      'select rank, symbol from atlas.entity_markets where entity_id = $1 and pinned = true order by rank',
      [e.entityId],
    );
    const assigned = assignMarketRanks(e.markets, pinned.rows);
    if (assigned.length) {
      out.push({ slug: e.slug, kind: 'write', rows: assigned.map((a) => ({ rank: a.rank, symbol: a.row.symbol, setBy: a.row.setBy, pinned: a.row.pinned })) });
    } else if (e.markets.length === 0) {
      // #696 an approved empty list is still an approval: the write transaction must run so
      // markets_checked_at is set and the next pass stops re-picking this entity.
      out.push({ slug: e.slug, kind: 'empty_write' });
    } else {
      out.push({ slug: e.slug, kind: 'nothing' });
    }
  }
  return out;
}

export type ApplyDeps = { db: pg.Pool; entries: ApplyEntry[]; yes: boolean; list?: () => Promise<ReadonlySet<string>>; log?: (line: string) => void };

/** The apply flow: refuse the whole file on any bad symbol, print the plan, then (only --yes) write.
 * Returns how many entities were refused (bad entityId or slug mismatch); the caller exits non-zero. */
export async function runApply(deps: ApplyDeps): Promise<number> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const live = await (deps.list ?? fetchHyperliquidMarkets)();
  validateApplyFile(deps.entries, live);
  const plan = await planApply(deps.db, deps.entries);
  for (const line of plan) log(planLine(line));
  if (!deps.yes) {
    log('nothing was written; pass --yes to write these rows');
    return 0;
  }
  let refused = 0;
  for (const [i, e] of deps.entries.entries()) {
    const line = plan[i]!;
    if (line.kind === 'missing' || line.kind === 'slug_mismatch') refused++;
  }
  for (const [i, e] of deps.entries.entries()) {
    const line = plan[i]!;
    // #696 empty_write runs the same writeMarkets transaction with zero rows; only refusals skip.
    if (line.kind !== 'write' && line.kind !== 'empty_write') continue;
    const r = await writeMarkets(deps.db, e.entityId, e.markets);
    if (r.outcome === 'skip') log(`${e.slug}: skipped: already checked`);
    else log(`${e.slug}: wrote ${r.rows} row(s)`);
  }
  return refused;
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

const usage = 'usage: markets:apply --file <json> [--yes]';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  for (const a of argv) if (a === '--help' || a === '-h') console.log(usage), process.exit(0);
  const file = arg(argv, '--file');
  const yes = argv.includes('--yes');
  if (!file) {
    console.error(`markets-apply: --file <path> is required; ${usage}`);
    process.exitCode = 1;
    return;
  }
  const dbUrl = process.env.ENTITY_MANAGER_DATABASE_URL?.trim();
  if (!dbUrl) {
    console.error('markets-apply: ENTITY_MANAGER_DATABASE_URL is required');
    process.exitCode = 1;
    return;
  }
  let entries: ApplyEntry[];
  try {
    entries = parseApplyFile(readFileSync(resolve(file), 'utf8'));
  } catch (e) {
    console.error(`markets-apply: refusing the file: ${(e as Error).message}`);
    process.exitCode = 1;
    return;
  }
  const pool = createPool(dbUrl);
  try {
    const refused = await runApply({ db: pool, entries, yes: yes || false });
    if (refused) process.exitCode = 1;
  } catch (e) {
    console.error(`markets-apply: refused the whole file, nothing written: ${(e as Error).message}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

/** Only run the script when invoked directly (tests import the functions). */
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((e: unknown) => {
    console.error(`markets-apply: ${(e as Error).message}`);
    process.exit(1);
  });
}
