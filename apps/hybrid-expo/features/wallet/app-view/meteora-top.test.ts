/**
 * Pure test for the Meteora app view top-block figures (issue #852).
 *
 * Covers the cases the issue names — a null value, a null P&L, a zero P&L —
 * plus the frame's acceptance scenario ("$1,918.00" / "$42.10" / no-data
 * glyph), the signed negative P&L the design's `sg` renders, and the two
 * inputs the caller guards for (no summary, no Meteora figures).
 *
 * Run: pnpm --filter hybrid-expo test:wallet
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { meteoraTopFigures } from './meteora-top';
import { NO_DATA } from '@/lib/format';
import type {
  AppSummary,
  MeteoraSummary,
  VenueStatus,
  WalletSummary,
} from '@myboon/shared/wallet-summary';

/** A minimal summary: every other app disconnected, Meteora from the input. */
function summaryWithMeteora(meteora: AppSummary<MeteoraSummary>): WalletSummary {
  const emptyApp = {
    status: 'not_connected' as VenueStatus,
    valueUsd: null,
    summary: null,
  };
  return {
    solana: 'SolanaAddr',
    evm: 'EvmAddr',
    fetchedAt: '2026-11-23T00:00:00Z',
    apps: {
      polymarket: emptyApp,
      phoenix: emptyApp,
      pacifica: emptyApp,
      meteora,
      spot: emptyApp,
    },
  };
}

function meteoraWith(input: {
  valueUsd: number | null;
  unclaimedFeesUsd: number | null;
  totalPnlUsd: number | null;
}): AppSummary<MeteoraSummary> {
  return {
    status: 'ok',
    valueUsd: input.valueUsd,
    summary: {
      poolCount: 2,
      totalPools: 2,
      hasMore: false,
      unclaimedFeesUsd: input.unclaimedFeesUsd,
      totalPnlUsd: input.totalPnlUsd,
      pools: [],
    },
  };
}

describe('meteoraTopFigures', () => {
  it('formats the frame scenario and shows the no-data glyph for a null P&L', () => {
    const figures = meteoraTopFigures(
      summaryWithMeteora(meteoraWith({ valueUsd: 1918, unclaimedFeesUsd: 42.1, totalPnlUsd: null })),
    );
    assert.deepEqual(figures, {
      poolValue: '$1,918.00',
      unclaimedFees: '$42.10',
      totalPnl: NO_DATA,
    });
  });

  it('shows the no-data glyph for a null pool value', () => {
    const figures = meteoraTopFigures(
      summaryWithMeteora(meteoraWith({ valueUsd: null, unclaimedFeesUsd: 0, totalPnlUsd: 1.5 })),
    );
    assert.deepEqual(figures, {
      poolValue: NO_DATA,
      unclaimedFees: '$0.00',
      totalPnl: '+$1.50',
    });
  });

  it('renders a zero P&L signed positive, never blank (design sg)', () => {
    const figures = meteoraTopFigures(
      summaryWithMeteora(meteoraWith({ valueUsd: 1918, unclaimedFeesUsd: null, totalPnlUsd: 0 })),
    );
    assert.deepEqual(figures, {
      poolValue: '$1,918.00',
      unclaimedFees: NO_DATA,
      totalPnl: '+$0.00',
    });
  });

  it('renders a negative P&L with the design minus sign and grouped money', () => {
    const figures = meteoraTopFigures(
      summaryWithMeteora(meteoraWith({ valueUsd: 12.4, unclaimedFeesUsd: 3, totalPnlUsd: -5.96 })),
    );
    assert.equal(figures?.poolValue, '$12.40');
    assert.equal(figures?.unclaimedFees, '$3.00');
    assert.equal(figures?.totalPnl, '−$5.96');
  });

  it('gives null for no summary at all (the caller shows skeleton or banner)', () => {
    assert.equal(meteoraTopFigures(null), null);
  });

  it('carries NO_DATA cells while the Meteora slot has no figures yet', () => {
    const figures = meteoraTopFigures(
      summaryWithMeteora({
        status: 'unavailable',
        valueUsd: null,
        summary: null,
        error: 'upstream failed',
      }),
    );
    assert.deepEqual(figures, {
      poolValue: NO_DATA,
      unclaimedFees: NO_DATA,
      totalPnl: NO_DATA,
    });
  });
});
