/**
 * Regression coverage for Home Wallet row refresh presentation (issue #277).
 *
 * Run: pnpm --filter hybrid-expo test:wallet
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { deriveWalletRowPresentation } from './wallet.rowPresentation';
import type { WalletSourceState, WalletSourceStatus } from './wallet.types';

function source(
  status: WalletSourceStatus,
  overrides: Partial<WalletSourceState> = {},
): WalletSourceState {
  return {
    status,
    valueUsd: null,
    resolvedAt: null,
    error: null,
    detail: null,
    ...overrides,
  };
}

describe('deriveWalletRowPresentation', () => {
  it('shows cold loading as pending without a retry affordance', () => {
    assert.deepEqual(deriveWalletRowPresentation(source('loading')), {
      hasValue: false,
      isPending: true,
      showColdRetry: false,
      showStaleRetry: false,
    });
  });

  it('shows retry only after a cold fetch fails', () => {
    assert.deepEqual(
      deriveWalletRowPresentation(source('failed', { error: 'Unable to sync' })),
      {
        hasValue: false,
        isPending: true,
        showColdRetry: true,
        showStaleRetry: false,
      },
    );
  });

  it('keeps a warm background refresh visually resolved', () => {
    assert.deepEqual(
      deriveWalletRowPresentation(
        source('loading', {
          valueUsd: 125,
          resolvedAt: 1_700_000_000_000,
        }),
      ),
      {
        hasValue: true,
        isPending: false,
        showColdRetry: false,
        showStaleRetry: false,
      },
    );
  });

  it('shows stale retry only after a warm refresh fails', () => {
    assert.deepEqual(
      deriveWalletRowPresentation(
        source('stale', {
          valueUsd: 125,
          resolvedAt: 1_700_000_000_000,
          error: 'Unable to sync',
        }),
      ),
      {
        hasValue: true,
        isPending: false,
        showColdRetry: false,
        showStaleRetry: true,
      },
    );
  });

  it('shows a successfully resolved source normally', () => {
    assert.deepEqual(
      deriveWalletRowPresentation(
        source('resolved', {
          valueUsd: 125,
          resolvedAt: 1_700_000_000_000,
        }),
      ),
      {
        hasValue: true,
        isPending: false,
        showColdRetry: false,
        showStaleRetry: false,
      },
    );
  });
});
