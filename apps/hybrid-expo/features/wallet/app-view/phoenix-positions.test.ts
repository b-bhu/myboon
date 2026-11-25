/**
 * Pure test for the Phoenix Positions tab card strings (issue #849) and the
 * positions state helpers.
 *
 * Run: pnpm --filter hybrid-expo exec tsx --test features/wallet/app-view/phoenix-positions.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { perpCardFigures, perpPrice, perpTag } from './phoenix-positions';
import { applyPerpPositionsResponse, perpPositionsUrl } from './perp-positions';
import { NO_DATA } from '@/lib/format';
import type { WalletPerpPositionDetail } from '@myboon/shared/wallet-summary';

function position(over: Partial<WalletPerpPositionDetail> = {}): WalletPerpPositionDetail {
  return {
    symbol: 'SOL-PERP',
    side: 'long',
    size: 1.24,
    leverage: 5,
    valueUsd: 213.5,
    entryPriceUsd: 150,
    markPriceUsd: 172.1,
    liquidationPriceUsd: 96800,
    unrealizedPnlUsd: 11.43,
    pnlPct: 29.31,
    takeProfitPriceUsd: 175,
    stopLossPriceUsd: 140,
    traderPdaIndex: 0,
    traderSubaccountIndex: 0,
    ...over,
  };
}

describe('perpCardFigures', () => {
  it('formats a long with leverage, P&L line and TP/SL', () => {
    const c = perpCardFigures(position());
    assert.equal(c.title, 'SOL-PERP');
    assert.equal(c.tag, 'Long 5×');
    assert.equal(c.size, '1.24 SOL');
    assert.equal(c.value, '$213.50');
    assert.equal(c.pnl, '+$11.43 · +29.3%');
    assert.equal(c.pnlTone, 'up');
    assert.equal(c.liq, '96,800.00');
    assert.equal(c.tpsl, 'TP 175.00 · SL 140.00');
    assert.equal(c.marketHref, '/markets/phoenix/SOL-PERP');
  });

  it('formats a losing short', () => {
    const c = perpCardFigures(
      position({ symbol: 'BTC-PERP', side: 'short', leverage: 3, unrealizedPnlUsd: -4.5, pnlPct: -2.04 }),
    );
    assert.equal(c.tag, 'Short 3×');
    assert.equal(c.pnl, '−$4.50 · −2.0%');
    assert.equal(c.pnlTone, 'down');
    assert.equal(c.size, '1.24 BTC');
  });

  it('drops the multiplier when leverage is null', () => {
    assert.equal(perpTag('long', null), 'Long');
    assert.equal(perpTag('short', null), 'Short');
  });

  it('shows the no-data glyph for null numbers, never 0', () => {
    const c = perpCardFigures(
      position({
        valueUsd: null,
        entryPriceUsd: null,
        markPriceUsd: null,
        liquidationPriceUsd: null,
        unrealizedPnlUsd: null,
        pnlPct: null,
      }),
    );
    assert.equal(c.value, NO_DATA);
    assert.equal(c.entry, NO_DATA);
    assert.equal(c.mark, NO_DATA);
    assert.equal(c.liq, NO_DATA);
    assert.equal(c.pnl, `${NO_DATA} · ${NO_DATA}`);
    assert.equal(c.pnlTone, null);
    assert.equal(perpPrice(null), NO_DATA);
  });

  it('says "not set" for a missing TP and SL', () => {
    const c = perpCardFigures(position({ takeProfitPriceUsd: null, stopLossPriceUsd: null }));
    assert.equal(c.tpsl, 'TP not set · SL not set');
  });
});

describe('perp positions state', () => {
  const held = { positions: [position()], error: null };

  it('builds the venue URL and skips a null address', () => {
    assert.equal(
      perpPositionsUrl('https://api.x', 'phoenix', 'ABC'),
      'https://api.x/wallet/phoenix/positions?solana=ABC',
    );
    assert.equal(perpPositionsUrl('https://api.x', 'phoenix', null), null);
  });

  it('takes the array on ok and not_connected', () => {
    assert.deepEqual(
      applyPerpPositionsResponse({ positions: null, error: 'x' }, 'phoenix', { status: 'ok', positions: [position()] }),
      held,
    );
    assert.deepEqual(applyPerpPositionsResponse(held, 'phoenix', { status: 'not_connected', positions: [] }), {
      positions: [],
      error: null,
    });
  });

  it('sets the error on unavailable and a failed request, keeping a held list', () => {
    const un = applyPerpPositionsResponse(held, 'phoenix', { status: 'unavailable', positions: [], error: 'down' });
    assert.deepEqual(un, { positions: held.positions, error: 'down' });
    const failed = applyPerpPositionsResponse({ positions: null, error: null }, 'phoenix', null);
    assert.deepEqual(failed, { positions: null, error: 'Phoenix positions request failed.' });
  });
});
