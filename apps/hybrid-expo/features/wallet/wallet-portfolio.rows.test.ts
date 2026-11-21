/**
 * Unit tests for the pure portfolio helpers (issue #768): each app's
 * summary line, the $1 dust filter, the Apps/Spot groups (sorted, hidden
 * statuses), and the top-5 cut. Pure scenarios only — no screen consumes
 * these helpers yet.
 *
 * Run: pnpm --filter hybrid-expo test:wallet
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { NO_DATA } from '@/lib/format';
import { walletSummaryFixture, type WalletSummary } from '@myboon/shared/wallet-summary';

import { appSummaryLines, DUST_USD, portfolioRows, topFive } from './wallet-portfolio.rows';

/** Independent fixture copy, mutated per scenario. */
function scenario(): WalletSummary {
  return structuredClone(walletSummaryFixture);
}

describe('appSummaryLines', () => {
  it('polymarket line: Cash · Bets · signed P&L', () => {
    assert.equal(
      appSummaryLines(scenario()).polymarket,
      'Cash $1,250.50 · Bets $6,750.00 · +$980.75',
    );
  });

  it('phoenix line: Equity · position count · signed P&L', () => {
    assert.equal(
      appSummaryLines(scenario()).phoenix,
      'Equity $43,012.40 · 2 positions · +$512.20',
    );
  });

  it('pacifica line: Available · count (singular) · NO_DATA P&L', () => {
    assert.equal(
      appSummaryLines(scenario()).pacifica,
      `Available $9,621.40 · 1 position · ${NO_DATA}`,
    );
  });

  it('meteora line: pools count with + while hasMore · fees', () => {
    assert.equal(appSummaryLines(scenario()).meteora, '2+ pools · $18.40 fees');
  });

  it('meteora line: no + and singular pool when hasMore is false', () => {
    const s = scenario();
    const summary = s.apps.meteora.summary;
    if (!summary) throw new Error('fixture must have a meteora summary');
    summary.poolCount = 1;
    summary.hasMore = false;
    summary.unclaimedFeesUsd = 0;
    assert.equal(appSummaryLines(s).meteora, '1 pool · $0.00 fees');
  });

  it('negative P&L takes a minus sign and zero P&L a plus sign', () => {
    const s = scenario();
    const summary = s.apps.polymarket.summary;
    if (!summary) throw new Error('fixture must have a polymarket summary');
    summary.totalPnlUsd = -3;
    assert.equal(
      appSummaryLines(s).polymarket,
      'Cash $1,250.50 · Bets $6,750.00 · -$3.00',
    );
    summary.totalPnlUsd = 0;
    assert.equal(appSummaryLines(s).polymarket, 'Cash $1,250.50 · Bets $6,750.00 · +$0.00');
  });

  it('not_connected app produces no line', () => {
    const s = scenario();
    s.apps.polymarket = { status: 'not_connected', valueUsd: null, summary: null };
    const lines = appSummaryLines(s);
    assert.equal(lines.polymarket, undefined);
    assert.ok(lines.phoenix && lines.pacifica && lines.meteora);
  });
});

describe('portfolioRows', () => {
  it('apps rows sorted by value desc', () => {
    const { apps } = portfolioRows(scenario());
    assert.deepEqual(
      apps.map((row) => [row.id, row.valueUsd]),
      [
        ['phoenix', 43012.4],
        ['pacifica', 12855.9],
        ['meteora', 10562.35],
        ['polymarket', 8231.75],
      ],
    );
    assert.deepEqual(
      apps.map((row) => row.group),
      ['apps', 'apps', 'apps', 'apps'],
    );
  });

  it('spot rows carry the token holdings, sorted by value desc', () => {
    const { spot } = portfolioRows(scenario());
    assert.deepEqual(
      spot.map((row) => [row.mint, row.symbol, row.valueUsd]),
      [
        ['So11111111111111111111111111111111111111112', 'SOL', 5310.25],
        ['ExampleMint111111111111111111111111111111111', null, 12.5],
      ],
    );
    assert.ok(spot.every((row) => !('summaryLine' in row)));
    assert.deepEqual(
      spot.map((row) => row.group),
      ['spot', 'spot'],
    );
  });

  it('values under $1 are hidden as dust, $1 exactly is kept', () => {
    const s = scenario();
    assert.equal(DUST_USD, 1);
    s.apps.spot.summary = {
      tokenCount: 3,
      tokens: [
        { mint: 'A', symbol: 'A', iconUrl: null, valueUsd: 0.99 },
        { mint: 'B', symbol: 'B', iconUrl: null, valueUsd: 1 },
        { mint: 'C', symbol: 'C', iconUrl: null, valueUsd: 2.5 },
      ],
    };
    const { spot } = portfolioRows(s);
    assert.deepEqual(
      spot.map((row) => [row.mint, row.valueUsd]),
      [
        ['C', 2.5],
        ['B', 1],
      ],
    );
  });

  it('not_connected app produces no row (the rule under Rule / change)', () => {
    const s = scenario();
    s.apps.phoenix = { status: 'not_connected', valueUsd: null, summary: null };
    const { apps } = portfolioRows(s);
    assert.ok(!apps.some((row) => row.id === 'phoenix'));
  });

  it('ok app with a null value and an unavailable app produce no row', () => {
    const s = scenario();
    s.apps.phoenix.valueUsd = null;
    s.apps.meteora = { status: 'unavailable', valueUsd: null, summary: null, error: 'upstream down' };
    const { apps } = portfolioRows(s);
    assert.deepEqual(
      apps.map((row) => row.id),
      ['pacifica', 'polymarket'],
    );
  });

  it('a dust app value is hidden too', () => {
    const s = scenario();
    s.apps.polymarket.valueUsd = 0.5;
    const { apps } = portfolioRows(s);
    assert.ok(!apps.some((row) => row.id === 'polymarket'));
  });
});

describe('topFive', () => {
  it('cuts to the top 5 in order and counts the rest', () => {
    const { spot } = portfolioRows((() => {
      const s = scenario();
      s.apps.spot.summary = {
        tokenCount: 7,
        tokens: [50, 40, 30, 25, 20, 15, 0.5].map((valueUsd, i) => ({
          mint: `mint-${i}`,
          symbol: `T${i}`,
          iconUrl: null,
          valueUsd,
        })),
      };
      return s;
    })());
    assert.equal(spot.length, 6); // 0.5 is dust
    const cut = topFive(spot);
    assert.deepEqual(
      cut.top.map((row) => row.valueUsd),
      [50, 40, 30, 25, 20],
    );
    assert.equal(cut.moreCount, 1);
  });

  it('under the limit: every row is top, moreCount 0', () => {
    const { apps } = portfolioRows(scenario());
    assert.equal(apps.length, 4);
    const cut = topFive(apps);
    assert.equal(cut.top.length, 4);
    assert.equal(cut.moreCount, 0);
  });

  it('empty group cuts to empty', () => {
    const cut = topFive([]);
    assert.deepEqual(cut.top, []);
    assert.equal(cut.moreCount, 0);
  });

  it('limit is the second argument', () => {
    const cut = topFive([50, 40, 30, 25, 20, 15].map((valueUsd) => ({ valueUsd })), 2);
    assert.deepEqual(cut.top, [{ valueUsd: 50 }, { valueUsd: 40 }]);
    assert.equal(cut.moreCount, 4);
  });
});
