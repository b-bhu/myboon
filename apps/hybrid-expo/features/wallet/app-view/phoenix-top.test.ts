/**
 * Pure test for the Phoenix app view top-block figures (issue #848).
 *
 * Covers the cases the issue names — an ok slot formats both cells, a null
 * collateral gives the no-data glyph, no summary gives null — plus the
 * acceptance scenario ($1,751.00 / $1,250.00, no Deposit | Withdraw), a null
 * balance, the unavailable slot, and the `usd` formatter #849 imports.
 *
 * Run: pnpm --filter hybrid-expo exec tsx --test features/wallet/app-view/phoenix-top.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { phoenixTopFigures, usd } from './phoenix-top';
import { NO_DATA } from '@/lib/format';
import type {
  AppSummary,
  PhoenixSummary,
  VenueStatus,
  WalletSummary,
} from '@myboon/shared/wallet-summary';

/** A minimal summary: every other app disconnected, Phoenix from the input. */
function summaryWithPhoenix(phoenix: AppSummary<PhoenixSummary>): WalletSummary {
  const emptyApp = {
    status: 'not_connected' as VenueStatus,
    valueUsd: null,
    summary: null,
  };
  return {
    solana: 'SolanaAddr',
    evm: 'EvmAddr',
    fetchedAt: '2026-11-24T00:00:00Z',
    apps: {
      polymarket: emptyApp,
      phoenix,
      pacifica: emptyApp,
      meteora: emptyApp,
      spot: emptyApp,
    },
  };
}

function phoenixWith(input: { valueUsd: number | null; collateralUsd: number | null }): AppSummary<PhoenixSummary> {
  return {
    status: 'ok',
    valueUsd: input.valueUsd,
    summary: {
      equityUsd: input.valueUsd,
      collateralUsd: input.collateralUsd,
      unrealizedPnlUsd: null,
      positionCount: 0,
      positions: [],
    },
  };
}

describe('phoenixTopFigures', () => {
  it('formats the acceptance scenario: $1,751.00 balance and $1,250.00 cash available', () => {
    const figures = phoenixTopFigures(
      summaryWithPhoenix(phoenixWith({ valueUsd: 1751, collateralUsd: 1250 })),
    );
    assert.deepEqual(figures, {
      balance: '$1,751.00',
      cashAvailable: '$1,250.00',
    });
  });

  it('shows the no-data glyph when collateralUsd is null, never $0.00', () => {
    const figures = phoenixTopFigures(
      summaryWithPhoenix(phoenixWith({ valueUsd: 1751, collateralUsd: null })),
    );
    assert.deepEqual(figures, {
      balance: '$1,751.00',
      cashAvailable: NO_DATA,
    });
  });

  it('shows the no-data glyph for a null balance', () => {
    const figures = phoenixTopFigures(
      summaryWithPhoenix(phoenixWith({ valueUsd: null, collateralUsd: 1250 })),
    );
    assert.deepEqual(figures, {
      balance: NO_DATA,
      cashAvailable: '$1,250.00',
    });
  });

  it('carries NO_DATA cells while the Phoenix slot is unavailable with no figures', () => {
    const figures = phoenixTopFigures(
      summaryWithPhoenix({
        status: 'unavailable',
        valueUsd: null,
        summary: null,
        error: 'upstream failed',
      }),
    );
    assert.deepEqual(figures, {
      balance: NO_DATA,
      cashAvailable: NO_DATA,
    });
  });

  it('gives null for no summary at all (the caller shows skeleton or banner)', () => {
    assert.equal(phoenixTopFigures(null), null);
  });
});

describe('usd', () => {
  it('groups and pins two decimals (the format meteoraTopFigures uses)', () => {
    assert.equal(usd(1250), '$1,250.00');
    assert.equal(usd(1751), '$1,751.00');
    assert.equal(usd(12.4), '$12.40');
    assert.equal(usd(0), '$0.00');
    assert.equal(usd(12345.6), '$12,345.60');
  });

  it('keeps a negative amount as the magnitudes the design helper reads', () => {
    // meteora-top.ts's `usd` drops the sign; the signed P&L carries it. Here
    // both cells are plain amounts, so the helper stays verbatim.
    assert.equal(usd(-5), '$5.00');
  });
});

describe('phoenixTopFigures for Pacifica (#857)', () => {
  it('reads equity and availableToSpendUsd from the Pacifica slot', () => {
    const emptyApp = { status: 'not_connected' as VenueStatus, valueUsd: null, summary: null };
    const summary: WalletSummary = {
      solana: 'SolanaAddr',
      evm: 'EvmAddr',
      fetchedAt: '2026-11-24T00:00:00Z',
      apps: {
        polymarket: emptyApp,
        phoenix: emptyApp,
        pacifica: {
          status: 'ok',
          valueUsd: 640,
          summary: {
            equityUsd: 640,
            availableToSpendUsd: null,
            unrealizedPnlUsd: null,
            positionCount: 0,
            positions: [],
          },
        },
        meteora: emptyApp,
        spot: emptyApp,
      },
    };
    assert.deepEqual(phoenixTopFigures(summary, 'pacifica'), { balance: '$640.00', cashAvailable: NO_DATA });
    // The default venue still reads the Phoenix slot (unchanged behavior).
    assert.deepEqual(phoenixTopFigures(summary), { balance: NO_DATA, cashAvailable: NO_DATA });
  });
});
