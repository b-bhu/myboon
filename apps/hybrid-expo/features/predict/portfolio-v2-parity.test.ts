/**
 * Parity guard for the Polymarket Data API v1 -> v2 migration of
 * fetchPortfolio() (issue #426, PR review requirement): the v2 OPEN +
 * REDEEMABLE position pages, once merged, must reproduce the summary totals
 * the old v1 GET /positions response produced for the same wallet.
 *
 * Fixtures were recorded live for wallet
 * 0x2b3e757626f6d5a371fbf2909ba609986e7ce135 (same minute):
 * - portfolio-426-v1-positions.json     v1 bare array, camelCase, 8 rows
 * - portfolio-426-v2-open.json          v2 {data:[...]} envelope, snake_case
 * - portfolio-426-v2-redeemable.json    v2 {data:[...]} envelope (subset)
 *
 * The v2 rows are parsed with the SDK's own PositionSchema before running the
 * merge -> map -> summarize pipeline from portfolio-summary.ts.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { realpathSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Position } from '@polymarket/client';
import { mapSdkPosition, mergeHeldPositions, summarizeHeldPositions, walkAllPages } from './portfolio-summary';

// '@polymarket/client' re-exports the bindings *types* (its index.d.ts does
// `export * from '@polymarket/bindings/data'`) but its runtime bundle does not
// re-export the zod schemas, and '@polymarket/bindings' is only a transitive
// dependency of the client, so it cannot be imported by name from the app.
// Resolve the bindings package next to the client package's real location
// (the pnpm store realpath) and load PositionSchema from there.
type PositionSchemaLike = typeof import('@polymarket/client').PositionSchema;

function extractPositionSchema(mod: Record<string, unknown>): PositionSchemaLike {
  const schema = mod.PositionSchema as PositionSchemaLike | undefined;
  assert.ok(schema && typeof schema.parse === 'function', 'PositionSchema missing from @polymarket/bindings/data');
  return schema;
}

async function loadPositionSchema(): Promise<PositionSchemaLike> {
  const clientDist = dirname(realpathSync(createRequire(import.meta.url).resolve('@polymarket/client')));
  const bindingsDataUrl = pathToFileURL(
    join(clientDist, '..', '..', 'bindings', 'dist', 'data', 'index.js'),
  ).href;
  return extractPositionSchema((await import(bindingsDataUrl)) as Record<string, unknown>);
}

let positionSchemaPromise: Promise<PositionSchemaLike> | null = null;

function getPositionSchema(): Promise<PositionSchemaLike> {
  positionSchemaPromise ??= loadPositionSchema();
  return positionSchemaPromise;
}

interface V1PositionRow {
  asset: string;
  cashPnl: number;
  currentValue: number;
}

function readFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(__dirname, '__fixtures__', name), 'utf8')) as unknown;
}

const V1_ROWS = readFixture('portfolio-426-v1-positions.json') as V1PositionRow[];
const OPEN_DATA = (readFixture('portfolio-426-v2-open.json') as { data: unknown[] }).data;
const REDEEMABLE_DATA = (readFixture('portfolio-426-v2-redeemable.json') as { data: unknown[] }).data;

// OLD totals, computed straight from the v1 fixture (same formulas fetchPortfolio() used):
// totalPnl = sum cashPnl, cashOutNow = sum currentValue, count = positions.length.
const OLD_TOTAL_PNL = V1_ROWS.reduce((sum, row) => sum + row.cashPnl, 0);
const OLD_CASH_OUT_NOW = V1_ROWS.reduce((sum, row) => sum + row.currentValue, 0);
const OLD_COUNT = V1_ROWS.length;
const OLD_ASSET_IDS = new Set(V1_ROWS.map((row) => row.asset));

interface PortfolioPositionLike {
  asset: string;
}

function assertSummaryMatchesOld(summary: { totalPnl: number; cashOutNow: number; activePickCount: number; openPositions: number }): void {
  assert.ok(Math.abs(summary.totalPnl - OLD_TOTAL_PNL) <= 1e-6, `totalPnl ${summary.totalPnl} != v1 ${OLD_TOTAL_PNL}`);
  assert.ok(Math.abs(summary.cashOutNow - OLD_CASH_OUT_NOW) <= 1e-6, `cashOutNow ${summary.cashOutNow} != v1 ${OLD_CASH_OUT_NOW}`);
  assert.equal(summary.activePickCount, OLD_COUNT);
  assert.equal(summary.openPositions, OLD_COUNT);
}

function assertAssetIdsMatchOld(positions: PortfolioPositionLike[]): void {
  const assetIds = new Set(positions.map((position) => position.asset));
  assert.deepEqual(assetIds, OLD_ASSET_IDS);
}

test('v2 OPEN + REDEEMABLE union reproduces the v1 held-position totals', async () => {
  const positionSchema = await getPositionSchema();
  const parseRow = (row: unknown): Position => positionSchema.parse(row);

  const open = OPEN_DATA.map(parseRow);
  const redeemable = REDEEMABLE_DATA.map(parseRow);
  const merged = mergeHeldPositions(open, redeemable);

  // Live behaviour: the OPEN status page already repeats the redeemable held
  // rows, so dedupe must keep exactly one row per assetId.
  assert.equal(merged.length, OLD_COUNT);

  const positions = merged.map(mapSdkPosition);
  assertSummaryMatchesOld(summarizeHeldPositions(positions));
  assertAssetIdsMatchOld(positions);
});

test('redeemable rows fold back in if the OPEN page stops listing them', async () => {
  const positionSchema = await getPositionSchema();
  const parseRow = (row: unknown): Position => positionSchema.parse(row);

  const openWithoutRedeemable = OPEN_DATA.filter((row) => {
    const wire = row as { status?: string; redeemable?: boolean };
    return wire.status !== 'REDEEMABLE' && wire.redeemable !== true;
  });
  assert.ok(openWithoutRedeemable.length < OPEN_DATA.length, 'fixture has no redeemable open rows to strip');

  const merged = mergeHeldPositions(
    openWithoutRedeemable.map(parseRow),
    REDEEMABLE_DATA.map(parseRow),
  );
  const positions = merged.map(mapSdkPosition);

  // The REDEEMABLE page filled the gap left by the stripped OPEN rows.
  assert.equal(positions.length, OLD_COUNT);
  assertSummaryMatchesOld(summarizeHeldPositions(positions));
  assertAssetIdsMatchOld(positions);
});

// --- Synthetic multi-page scenarios for the #445 totals walk ---

interface SdkPage<T> {
  items: T[];
  hasMore: boolean;
}

function syntheticPosition(base: Position, assetId: string): Position {
  // The SDK brands assetId (TokenId | PositionId); synthetic rows only feed
  // the dedupe/map/summarize helpers, which treat it as an opaque string.
  return { ...base, assetId: assetId as Position['assetId'] };
}

/** Cycle the parsed fixture rows into clones with distinct assetIds. */
function syntheticRows(parsed: Position[], count: number, suffix: string): Position[] {
  return Array.from({ length: count }, (_, i) =>
    syntheticPosition(parsed[i % parsed.length], `${parsed[i % parsed.length].assetId}${suffix}-${i}`),
  );
}

function chunkIntoPages<T>(rows: T[], perPage: number): SdkPage<T>[] {
  const pages: SdkPage<T>[] = [];
  for (let start = 0; start < rows.length; start += perPage) {
    const isLastPage = start + perPage >= rows.length;
    pages.push({ items: rows.slice(start, start + perPage), hasMore: !isLastPage });
  }
  return pages;
}

/** Fake v2 paginator: yields pages verbatim and counts how many were pulled. */
function fakePaginator<T>(pages: SdkPage<T>[], pulled: { count: number }): AsyncGenerator<SdkPage<T>> {
  return (async function* () {
    for (const page of pages) {
      pulled.count += 1;
      yield page;
    }
  })();
}

test('over-cap wallet: summary totals cover every page while the returned list stays capped', async () => {
  const positionSchema = await getPositionSchema();
  const parsed = OPEN_DATA.map((row) => positionSchema.parse(row));

  // 3 open pages of 50 = 150 held rows with distinct assetIds.
  const openRows = syntheticRows(parsed, 150, '-open');
  // Two redeemable pages of 20, each mixing duplicates of open assetIds with
  // redeem-only rows (the deduped union grows by 20 new rows).
  const redeemOnly = syntheticRows(parsed, 20, '-redeemable-only');
  const redeemableRows: Position[] = [
    ...openRows.slice(0, 10).map((row) => syntheticPosition(row, row.assetId)),
    ...redeemOnly.slice(0, 10),
    ...openRows.slice(10, 20).map((row) => syntheticPosition(row, row.assetId)),
    ...redeemOnly.slice(10, 20),
  ];

  const openWalk = await walkAllPages(fakePaginator(chunkIntoPages(openRows, 50), { count: 0 }));
  assert.equal(openWalk.partial, false);
  assert.equal(openWalk.items.length, 150);
  const redeemableWalk = await walkAllPages(fakePaginator(chunkIntoPages(redeemableRows, 20), { count: 0 }));
  assert.equal(redeemableWalk.partial, false);
  assert.equal(redeemableWalk.items.length, 40);

  // Independent dedupe (contract: assetId union, open rows win) the summary
  // numbers are checked against.
  const expected = new Map<string, Position>();
  for (const row of [...openRows, ...redeemableRows]) {
    if (!expected.has(row.assetId)) expected.set(row.assetId, row);
  }
  const expectedRows = [...expected.values()];
  assert.ok(expectedRows.length > 100, `synthetic wallet should exceed the 100-row list cap, got ${expectedRows.length}`);

  const merged = mergeHeldPositions(openWalk.items, redeemableWalk.items).map(mapSdkPosition);
  assert.equal(merged.length, expectedRows.length);

  const summary = summarizeHeldPositions(merged, openWalk.partial || redeemableWalk.partial);
  const expectedPnl = expectedRows.reduce((sum, row) => sum + Number(row.unrealizedPnl), 0);
  const expectedValue = expectedRows.reduce((sum, row) => sum + Number(row.currentValue), 0);
  assert.ok(Math.abs(summary.totalPnl - expectedPnl) <= 1e-6, `totalPnl ${summary.totalPnl} != ${expectedPnl}`);
  assert.ok(Math.abs(summary.cashOutNow - expectedValue) <= 1e-6, `cashOutNow ${summary.cashOutNow} != ${expectedValue}`);
  // The totals are not the sums of the capped first-100 list.
  const cappedPnl = merged.slice(0, 100).reduce((sum, row) => sum + row.cashPnl, 0);
  const cappedValue = merged.slice(0, 100).reduce((sum, row) => sum + row.currentValue, 0);
  assert.ok(Math.abs(cappedPnl - expectedPnl) > 1e-6, 'capped and uncapped PnL sums unexpectedly match');
  assert.ok(Math.abs(cappedValue - expectedValue) > 1e-6, 'capped and uncapped value sums unexpectedly match');

  assert.equal(summary.totalPositionCount, merged.length);
  assert.equal(summary.activePickCount, merged.length);
  assert.equal(summary.totalsPartial, false);
  // The returned list stays capped at 100 while the count covers all pages.
  assert.equal(merged.slice(0, 100).length, 100);
  assert.ok(summary.totalPositionCount > 100, `totalPositionCount ${summary.totalPositionCount} should exceed the cap`);
});

test('page walk stops at the 20-page ceiling and marks totals partial', async () => {
  const positionSchema = await getPositionSchema();
  const parsed = OPEN_DATA.map((row) => positionSchema.parse(row));

  // 25 pages of 2 rows; every page reports hasMore=true except the last.
  const rows = syntheticRows(parsed, 50, '-ceiling');
  const pages = chunkIntoPages(rows, 2);
  assert.equal(pages.length, 25);

  const pulled = { count: 0 };
  const walk = await walkAllPages(fakePaginator(pages, pulled));
  assert.equal(walk.partial, true);
  // Exactly 20 pages were consumed; page 21 is never requested.
  assert.equal(pulled.count, 20);
  assert.equal(walk.items.length, 40);

  const summary = summarizeHeldPositions(walk.items.map(mapSdkPosition), walk.partial);
  assert.equal(summary.totalsPartial, true);
  assert.equal(summary.totalPositionCount, 40);
});

test('exactly 20 pages whose last page has hasMore=false is not partial', async () => {
  const positionSchema = await getPositionSchema();
  const parsed = OPEN_DATA.map((row) => positionSchema.parse(row));

  const rows = syntheticRows(parsed, 20, '-exact');
  const pages = chunkIntoPages(rows, 1); // 20 pages, last one hasMore=false
  assert.equal(pages.length, 20);

  const pulled = { count: 0 };
  const walk = await walkAllPages(fakePaginator(pages, pulled));
  assert.equal(walk.partial, false);
  assert.equal(pulled.count, 20);

  const summary = summarizeHeldPositions(walk.items.map(mapSdkPosition), walk.partial);
  assert.equal(summary.totalsPartial, false);
  assert.equal(summary.totalPositionCount, 20);
});