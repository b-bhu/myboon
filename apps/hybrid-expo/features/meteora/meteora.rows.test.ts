/**
 * Unit tests for Meteora's pure row logic.
 *
 * Run: pnpm --filter hybrid-expo test:markets
 *
 * React-free, react-native-free — imports only meteora.rows.ts, the
 * `MeteoraPoolSummary` type (type-only) and lib/format.ts (via
 * meteora.rows.ts). Does NOT import meteora.adapter.ts or
 * lib/token-identity.ts's React hook surface — only the pure `mintRef`
 * helper via meteora.rows.ts.
 *
 * Does NOT import `MeteoraExecutionControls.tsx` for `METEORA_COLORS`
 * either — that file imports `@expo/vector-icons` and `react-native` (it's
 * a component file), which would break `tsx --test`. The expected color
 * values are inlined here instead, matching meteora.rows.ts's local copy.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { METEORA_COLUMNS, METEORA_THEME, meteoraToRow } from './meteora.rows';

import type { MeteoraPoolSummary, MeteoraTokenSummary } from '@myboon/shared/meteora';
import type { TokenIdentity } from '@/lib/token-identity';

/** Matches `METEORA_COLORS` in `MeteoraExecutionControls.tsx` and the local copy in `meteora.rows.ts`. */
const METEORA_COLORS = {
  screen: '#103D4C',
  violet: '#7A6CFF',
  cyan: '#29C6D1',
  green: '#34D399',
  red: '#FF627D',
} as const;

function token(overrides: Partial<MeteoraTokenSummary> = {}): MeteoraTokenSummary {
  return {
    address: 'So11111111111111111111111111111111111111112',
    symbol: 'SOL',
    name: 'Wrapped SOL',
    decimals: 9,
    iconUrl: 'https://meteora.cdn/sol.png',
    verified: true,
    ...overrides,
  };
}

function pool(overrides: Partial<MeteoraPoolSummary> = {}): MeteoraPoolSummary {
  return {
    address: 'PoolAddress111111111111111111111111111111',
    pair: 'SOL / USDC',
    tokenX: token(),
    tokenY: token({ address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC', name: 'USD Coin', iconUrl: null }),
    currentPrice: '150.25',
    tvlUsd: '450000',
    volume24hUsd: '88000',
    fees24hUsd: '1200',
    feeTvl24hPct: '0.26',
    baseFeePct: '0.25',
    dynamicFeePct: '0.01',
    apr24hPct: '12.5',
    apy24hPct: '13.3',
    binStep: 20,
    hasFarm: false,
    tags: [],
    approvedByMeteora: true,
    ...overrides,
  };
}

function identity(overrides: Partial<TokenIdentity> = {}): TokenIdentity {
  return {
    key: 'mint:So11111111111111111111111111111111111111112',
    assetId: 'sol',
    symbol: 'SOL',
    name: 'Solana',
    iconUrl: '/tokens/icon/sol',
    decimals: 9,
    mint: 'So11111111111111111111111111111111111111112',
    verified: true,
    category: 'crypto',
    fallbackLetter: 'S',
    source: 'snapshot',
    ...overrides,
  };
}

describe('meteoraToRow', () => {
  it('builds a pair row with a full identity map (identity-tier fallback)', () => {
    const p = pool();
    const identities = new Map([
      ['mint:So11111111111111111111111111111111111111112', identity()],
    ]);
    const row = meteoraToRow(p, identities);

    assert.equal(row.key, p.address);
    assert.equal(row.title, 'SOL / USDC');
    assert.equal(row.href, `/markets/meteora/${p.address}`);
    assert.equal(row.lead.kind, 'pair');
    if (row.lead.kind === 'pair') {
      assert.equal(row.lead.x.identityRef, 'mint:So11111111111111111111111111111111111111112');
      assert.equal(row.lead.x.letter, 'S');
      assert.equal(row.lead.x.tint, METEORA_COLORS.cyan);
      assert.equal(row.lead.y.tint, METEORA_COLORS.violet);
    }
  });

  it('builds a pair row with an empty identity map (Meteora-icon / letter fallback tier)', () => {
    const p = pool();
    const row = meteoraToRow(p, new Map());
    assert.equal(row.lead.kind, 'pair');
    if (row.lead.kind === 'pair') {
      // Meteora keeps its own icon as second-tier fallback (risk note in the PRD).
      assert.equal(row.lead.x.venueIconUrl, 'https://meteora.cdn/sol.png');
      assert.equal(row.lead.x.letter, 'S');
      // tokenY has no venue icon in this fixture — letter fallback from symbol.
      assert.equal(row.lead.y.venueIconUrl, null);
      assert.equal(row.lead.y.letter, 'U');
    }
  });

  it('always produces exactly 3 cells', () => {
    const row = meteoraToRow(pool(), new Map());
    assert.equal(row.cells.length, 3);
  });

  it('always produces a non-empty a11yLabel', () => {
    const row = meteoraToRow(pool(), new Map());
    assert.ok(row.a11yLabel.length > 0);
    assert.match(row.a11yLabel, /^Open SOL USDC Meteora pool\./);
    assert.match(row.a11yLabel, /base fee/);
    assert.match(row.a11yLabel, /fees in 24 hours/);
    assert.match(row.a11yLabel, /total liquidity/);
    assert.match(row.a11yLabel, /volume in 24 hours/);
  });

  it('subtitle includes the fee and Farm suffix when hasFarm is true', () => {
    const row = meteoraToRow(pool({ hasFarm: true }), new Map());
    assert.match(row.subtitle ?? '', /Farm$/);
  });

  it('subtitle omits the Farm suffix when hasFarm is false', () => {
    const row = meteoraToRow(pool({ hasFarm: false }), new Map());
    assert.doesNotMatch(row.subtitle ?? '', /Farm/);
  });
});

describe('METEORA_THEME', () => {
  it('keeps its own palette rather than the shared default (acceptance criterion 8)', () => {
    assert.equal(METEORA_THEME.screen, METEORA_COLORS.screen);
    assert.equal(METEORA_THEME.accent, METEORA_COLORS.violet);
    assert.equal(METEORA_THEME.pos, METEORA_COLORS.green);
    assert.equal(METEORA_THEME.neg, METEORA_COLORS.red);
  });
});

describe('METEORA_COLUMNS', () => {
  it('matches the screen constants (Fees 58, TVL 58, Volume 62)', () => {
    assert.deepEqual(
      METEORA_COLUMNS.map((c) => c.width),
      [58, 58, 62],
    );
  });
});

describe('identity reaches the lead (regression)', () => {
  // The bug this guards: meteoraToRow looked identities up, used them for the
  // fallback LETTER, and then dropped them — so the row model carried no icon
  // URL at all and every pool rendered a letter box even though the server had
  // resolved a real icon. Meteora's own API has no icon field, so identity is
  // the ONLY icon source a pool row has; losing it here loses it entirely.
  it('carries identityIconUrl for both legs when identities resolve', () => {
    const p = pool();
    const identities = new Map([
      [`mint:${p.tokenX.address}`, identity({ iconUrl: '/tokens/icon/mint/x-mint' })],
      [`mint:${p.tokenY.address}`, identity({ iconUrl: '/tokens/icon/mint/y-mint' })],
    ]);
    const row = meteoraToRow(p, identities);
    assert.equal(row.lead.kind, 'pair');
    if (row.lead.kind !== 'pair') return;
    assert.equal(row.lead.x.identityIconUrl, '/tokens/icon/mint/x-mint');
    assert.equal(row.lead.y.identityIconUrl, '/tokens/icon/mint/y-mint');
  });

  it('leaves identityIconUrl null when nothing resolved, so the letter box shows', () => {
    const row = meteoraToRow(pool(), new Map());
    assert.equal(row.lead.kind, 'pair');
    if (row.lead.kind !== 'pair') return;
    assert.equal(row.lead.x.identityIconUrl, null);
    assert.equal(row.lead.y.identityIconUrl, null);
  });
});
