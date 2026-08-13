/**
 * Unit tests for Phoenix's pure row logic.
 *
 * Run: pnpm --filter hybrid-expo test:markets
 *
 * React-free, react-native-free — imports only phoenix.rows.ts, the
 * `PhoenixMarket` type (type-only) and lib/format.ts (via phoenix.rows.ts).
 * Does NOT import phoenix.adapter.ts or lib/token-identity.ts's React hook
 * surface — only the pure `perpRef` helper via phoenix.rows.ts.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { NO_DATA } from '@/lib/format';
import {
  phoenixMarketLabel,
  phoenixMatchesQuery,
  phoenixToRow,
  sortByOpenInterestDesc,
} from './phoenix.rows';

import type { PhoenixMarket } from './phoenix.api';
import type { TokenIdentity } from '@/lib/token-identity';

function market(overrides: Partial<PhoenixMarket> = {}): PhoenixMarket {
  return {
    venueId: 'phoenix',
    symbol: 'BTC-PERP',
    venueSymbol: 'BTC',
    baseSymbol: 'BTC',
    displayName: 'BTC Perpetual',
    quoteSymbol: 'USDC',
    iconPath: '/icons/btc.svg',
    status: 'active',
    tradeable: true,
    maxLeverage: 20,
    tickSize: '0.1',
    lotSize: '0.001',
    minOrderSize: '0.001',
    markPrice: 65000,
    oraclePrice: 65000,
    midPrice: 65000,
    fundingRate: 0.0001,
    openInterest: 1_500_000,
    volume24h: 5_000_000,
    change24h: 2.5,
    dataFreshness: 'live',
    dataFreshnessReason: null,
    configFetchedAt: null,
    precision: { tickSize: null, rawTickSize: null, baseLotsDecimals: null },
    limits: { openInterestCapBaseLots: null, maxLiquidationSizeBaseLots: null, leverageTiers: [] },
    fees: { makerFee: null, takerFee: null },
    funding: {
      fundingIntervalSeconds: null,
      fundingPeriodSeconds: null,
      maxFundingRatePerInterval: null,
      maxFundingRatePerIntervalPercentage: null,
    },
    metadata: { assetId: null, marketPubkey: null, splinePubkey: null, isolatedOnly: null },
    ...overrides,
  };
}

function identity(overrides: Partial<TokenIdentity> = {}): TokenIdentity {
  return {
    key: 'perp:BTC',
    assetId: 'btc',
    symbol: 'BTC',
    name: 'Bitcoin',
    iconUrl: '/tokens/icon/btc',
    decimals: null,
    mint: null,
    verified: true,
    category: 'crypto',
    fallbackLetter: 'B',
    source: 'snapshot',
    ...overrides,
  };
}

describe('phoenixMarketLabel', () => {
  it('prefers baseSymbol', () => {
    assert.equal(phoenixMarketLabel(market({ baseSymbol: 'BTC', venueSymbol: 'X', symbol: 'Y' })), 'BTC');
  });

  it('falls back to venueSymbol when baseSymbol is empty', () => {
    assert.equal(phoenixMarketLabel(market({ baseSymbol: '', venueSymbol: 'ETH' })), 'ETH');
  });

  it('falls back to stripping -PERP from symbol when both are empty', () => {
    assert.equal(phoenixMarketLabel(market({ baseSymbol: '', venueSymbol: '', symbol: 'SOL-PERP' })), 'SOL');
  });
});

describe('phoenixToRow', () => {
  it('builds a row with a full identity map (identity-tier fallback)', () => {
    const identities = new Map([['perp:BTC', identity()]]);
    const row = phoenixToRow(market(), identities);

    assert.equal(row.key, 'BTC-PERP');
    assert.equal(row.title, 'BTC');
    assert.equal(row.titleSuffix, '20×');
    assert.deepEqual(row.lead, {
      kind: 'token',
      identityRef: 'perp:BTC',
      // The resolved identity icon has to reach the row model, or the shell has
      // no way to render tier 1 and every row falls back to the letter box.
      identityIconUrl: '/tokens/icon/btc',
      venueIconUrl: '/icons/btc.svg',
      letter: 'B',
    });
    assert.equal(row.href, '/markets/phoenix/BTC-PERP');
  });

  it('builds a row with an empty identity map (letter-from-label fallback tier)', () => {
    const row = phoenixToRow(market(), new Map());
    assert.equal(row.lead.kind, 'token');
    if (row.lead.kind === 'token') {
      assert.equal(row.lead.letter, 'B');
    }
  });

  it('always produces exactly 3 cells', () => {
    const row = phoenixToRow(market(), new Map());
    assert.equal(row.cells.length, 3);
  });

  it('always produces a non-empty a11yLabel (closes Phoenix a11y parity)', () => {
    const row = phoenixToRow(market(), new Map());
    assert.ok(row.a11yLabel.length > 0);
    assert.match(row.a11yLabel, /^Open BTC-PERP\./);
  });

  it('leverage placeholder is NO_DATA when maxLeverage is null', () => {
    const row = phoenixToRow(market({ maxLeverage: null }), new Map());
    assert.equal(row.titleSuffix, NO_DATA);
  });

  it('tone is pos for non-negative change', () => {
    const row = phoenixToRow(market({ change24h: 1.1 }), new Map());
    assert.equal(row.cells[1].tone, 'pos');
  });

  it('tone is neg for negative change', () => {
    const row = phoenixToRow(market({ change24h: -1.1 }), new Map());
    assert.equal(row.cells[1].tone, 'neg');
  });

  it('tone is dim when change is null', () => {
    const row = phoenixToRow(market({ change24h: null }), new Map());
    assert.equal(row.cells[1].tone, 'dim');
    assert.equal(row.cells[1].text, NO_DATA);
  });
});

describe('phoenixMatchesQuery', () => {
  it('matches on the full symbol', () => {
    assert.equal(phoenixMatchesQuery(market({ symbol: 'BTC-PERP' }), 'BTC-PERP'), true);
  });

  it('matches on baseSymbol', () => {
    assert.equal(phoenixMatchesQuery(market({ baseSymbol: 'BTC' }), 'BTC'), true);
  });

  it('is case-insensitive', () => {
    assert.equal(phoenixMatchesQuery(market({ symbol: 'BTC-PERP' }), 'btc-perp'), true);
  });

  it('handles denominated symbols like kPEPE without uppercasing', () => {
    assert.equal(phoenixMatchesQuery(market({ symbol: 'kPEPE-PERP', baseSymbol: 'kPEPE' }), 'kpepe'), true);
  });

  it('returns false for a non-matching query', () => {
    assert.equal(phoenixMatchesQuery(market({ symbol: 'BTC-PERP', baseSymbol: 'BTC' }), 'ETH'), false);
  });
});

describe('sortByOpenInterestDesc (Phoenix)', () => {
  it('sorts by open interest descending', () => {
    const a = market({ symbol: 'AAA-PERP', baseSymbol: 'AAA', openInterest: 100 });
    const b = market({ symbol: 'BBB-PERP', baseSymbol: 'BBB', openInterest: 500 });
    const sorted = [a, b].sort(sortByOpenInterestDesc);
    assert.deepEqual(sorted.map((m) => m.symbol), ['BBB-PERP', 'AAA-PERP']);
  });

  it('sorts null open interest last', () => {
    const withOi = market({ symbol: 'AAA-PERP', baseSymbol: 'AAA', openInterest: 10 });
    const nullOi = market({ symbol: 'ZZZ-PERP', baseSymbol: 'ZZZ', openInterest: null });
    const sorted = [nullOi, withOi].sort(sortByOpenInterestDesc);
    assert.deepEqual(sorted.map((m) => m.symbol), ['AAA-PERP', 'ZZZ-PERP']);
  });

  it('breaks ties by label ascending, including when both are missing', () => {
    const a = market({ symbol: 'B-PERP', baseSymbol: 'BBB', openInterest: null });
    const b = market({ symbol: 'A-PERP', baseSymbol: 'AAA', openInterest: null });
    const sorted = [a, b].sort(sortByOpenInterestDesc);
    assert.deepEqual(sorted.map((m) => m.baseSymbol), ['AAA', 'BBB']);
  });
});
