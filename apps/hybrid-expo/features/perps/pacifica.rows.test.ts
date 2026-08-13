/**
 * Unit tests for Pacifica's pure row logic.
 *
 * Run: pnpm --filter hybrid-expo test:markets
 *
 * React-free, react-native-free — only imports pacifica.rows.ts,
 * venue.contract.ts (types only), and lib/format.ts (via pacifica.rows.ts).
 * Does NOT import pacifica.adapter.ts or lib/token-identity.ts's React hook
 * surface directly — only the pure `perpRef` helper via pacifica.rows.ts.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { NO_DATA } from '@/lib/format';
import {
  pacificaBaseSymbol,
  pacificaMatchesQuery,
  pacificaToRow,
  sortByOpenInterestDesc,
} from './pacifica.rows';

import type { PerpsMarket } from './perps.types';
import type { TokenIdentity } from '@/lib/token-identity';

function market(overrides: Partial<PerpsMarket> = {}): PerpsMarket {
  return {
    symbol: 'BTC-PERP',
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
    yesterdayPrice: 63500,
    iconPath: '/icons/btc.svg',
    ...overrides,
  };
}

function identity(overrides: Partial<TokenIdentity> = {}): TokenIdentity {
  return {
    key: 'perp:BTC-PERP',
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

describe('pacificaBaseSymbol', () => {
  it('strips the -PERP suffix', () => {
    assert.equal(pacificaBaseSymbol('BTC-PERP'), 'BTC');
  });

  it('preserves case for denominated symbols like kPEPE-PERP', () => {
    assert.equal(pacificaBaseSymbol('kPEPE-PERP'), 'kPEPE');
    assert.equal(pacificaBaseSymbol('kBONK-PERP'), 'kBONK');
  });

  it('returns the input unchanged when there is no separator', () => {
    assert.equal(pacificaBaseSymbol('BTC'), 'BTC');
  });
});

describe('pacificaToRow', () => {
  it('builds a row with a full identity map (identity-tier fallback)', () => {
    const identities = new Map([['perp:BTC-PERP', identity()]]);
    const row = pacificaToRow(market(), identities);

    assert.equal(row.key, 'BTC-PERP');
    assert.equal(row.title, 'BTC-PERP');
    assert.equal(row.titleSuffix, '20×');
    assert.deepEqual(row.lead, {
      kind: 'token',
      identityRef: 'perp:BTC-PERP',
      venueIconUrl: '/icons/btc.svg',
      letter: 'B',
    });
    assert.equal(row.href, '/markets/pacifica/BTC-PERP');
  });

  it('builds a row with an empty identity map (letter-from-symbol fallback tier)', () => {
    const row = pacificaToRow(market(), new Map());
    assert.equal(row.lead.kind, 'token');
    if (row.lead.kind === 'token') {
      assert.equal(row.lead.letter, 'B');
      assert.equal(row.lead.venueIconUrl, '/icons/btc.svg');
    }
  });

  it('always produces exactly 3 cells', () => {
    const row = pacificaToRow(market(), new Map());
    assert.equal(row.cells.length, 3);
  });

  it('always produces a non-empty a11yLabel', () => {
    const row = pacificaToRow(market(), new Map());
    assert.ok(row.a11yLabel.length > 0);
    assert.match(row.a11yLabel, /^Open BTC-PERP\./);
    assert.match(row.a11yLabel, /open interest/);
    assert.match(row.a11yLabel, /24 hour change/);
  });

  it('tone is pos for non-negative change', () => {
    const row = pacificaToRow(market({ change24h: 3.1 }), new Map());
    assert.equal(row.cells[1].tone, 'pos');
  });

  it('tone is neg for negative change', () => {
    const row = pacificaToRow(market({ change24h: -1.2 }), new Map());
    assert.equal(row.cells[1].tone, 'neg');
  });

  it('tone is dim when change is the 0-sentinel (no data)', () => {
    const row = pacificaToRow(market({ change24h: 0 }), new Map());
    assert.equal(row.cells[1].tone, 'dim');
    assert.equal(row.cells[1].text, NO_DATA);
  });

  it('renders NO_DATA for 0-sentinel markPrice instead of $0.00', () => {
    const row = pacificaToRow(market({ markPrice: 0 }), new Map());
    assert.equal(row.cells[0].text, NO_DATA);
  });

  it('renders NO_DATA for 0-sentinel openInterest instead of $0.00', () => {
    const row = pacificaToRow(market({ openInterest: 0 }), new Map());
    assert.equal(row.cells[2].text, NO_DATA);
    assert.match(row.a11yLabel, /Unavailable open interest/);
  });

  it('a real (non-zero) markPrice renders as a price, not NO_DATA', () => {
    const row = pacificaToRow(market({ markPrice: 65000 }), new Map());
    assert.notEqual(row.cells[0].text, NO_DATA);
    assert.match(row.cells[0].text, /^\$/);
  });
});

describe('pacificaMatchesQuery', () => {
  it('matches on the full venue symbol', () => {
    assert.equal(pacificaMatchesQuery(market({ symbol: 'BTC-PERP' }), 'BTC-PERP'), true);
  });

  it('matches on the base symbol (before the dash)', () => {
    assert.equal(pacificaMatchesQuery(market({ symbol: 'BTC-PERP' }), 'BTC'), true);
  });

  it('is case-insensitive', () => {
    assert.equal(pacificaMatchesQuery(market({ symbol: 'BTC-PERP' }), 'btc'), true);
    assert.equal(pacificaMatchesQuery(market({ symbol: 'BTC-PERP' }), 'btc-perp'), true);
  });

  it('handles denominated symbols like kPEPE-PERP without uppercasing them', () => {
    assert.equal(pacificaMatchesQuery(market({ symbol: 'kPEPE-PERP' }), 'kpepe'), true);
    assert.equal(pacificaMatchesQuery(market({ symbol: 'kPEPE-PERP' }), 'KPEPE'), true);
  });

  it('returns false for a non-matching query', () => {
    assert.equal(pacificaMatchesQuery(market({ symbol: 'BTC-PERP' }), 'ETH'), false);
  });

  it('an empty/whitespace query matches everything', () => {
    assert.equal(pacificaMatchesQuery(market(), ''), true);
    assert.equal(pacificaMatchesQuery(market(), '   '), true);
  });
});

describe('sortByOpenInterestDesc (Pacifica)', () => {
  it('sorts by open interest descending', () => {
    const a = market({ symbol: 'AAA-PERP', openInterest: 100 });
    const b = market({ symbol: 'BBB-PERP', openInterest: 500 });
    const sorted = [a, b].sort(sortByOpenInterestDesc);
    assert.deepEqual(sorted.map((m) => m.symbol), ['BBB-PERP', 'AAA-PERP']);
  });

  it('treats the 0-sentinel as missing and sorts it last', () => {
    const withOi = market({ symbol: 'AAA-PERP', openInterest: 10 });
    const zeroOi = market({ symbol: 'ZZZ-PERP', openInterest: 0 });
    const sorted = [zeroOi, withOi].sort(sortByOpenInterestDesc);
    assert.deepEqual(sorted.map((m) => m.symbol), ['AAA-PERP', 'ZZZ-PERP']);
  });

  it('breaks ties by symbol ascending, including when both are missing', () => {
    const a = market({ symbol: 'BBB-PERP', openInterest: 0 });
    const b = market({ symbol: 'AAA-PERP', openInterest: 0 });
    const sorted = [a, b].sort(sortByOpenInterestDesc);
    assert.deepEqual(sorted.map((m) => m.symbol), ['AAA-PERP', 'BBB-PERP']);
  });
});
