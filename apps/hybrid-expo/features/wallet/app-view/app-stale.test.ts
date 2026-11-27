/**
 * Pure test for the app view's stale helper (issue #864).
 *
 * staleAgeText: the six minute counts the issue names (0, 1, 2, 59, 60,
 * 120), the never-below-0 rule and an unparsable date. appIsStale: the
 * rule's inputs — held with a value, held without a value, no summary —
 * plus no error and the named-slot check across the three app views.
 *
 * Run: pnpm --filter hybrid-expo test:wallet
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { appIsStale, staleAgeText } from './app-stale';
import type { AppSummary, VenueStatus, WalletSummary } from '@myboon/shared/wallet-summary';

const NOW = Date.parse('2026-11-23T12:00:00Z');

/** An ISO-8601 stamp `minutes` before NOW; negative makes a future stamp. */
const at = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();

/** A slot that holds a value (or null one), as the summary route serves. */
const withValue = <T,>(valueUsd: number | null): AppSummary<T> => ({
  status: 'ok' as VenueStatus,
  valueUsd,
  summary: null,
});
const empty = {
  status: 'not_connected' as VenueStatus,
  valueUsd: null,
  summary: null,
};

/** A summary where exactly the named app view's app holds `valueUsd`. */
function summaryWith(
  app: 'phoenix' | 'pacifica' | 'meteora',
  valueUsd: number | null,
): WalletSummary {
  return {
    solana: 'SolanaAddr',
    evm: null,
    fetchedAt: at(2),
    apps: {
      polymarket: empty,
      phoenix: app === 'phoenix' ? withValue(valueUsd) : empty,
      pacifica: app === 'pacifica' ? withValue(valueUsd) : empty,
      meteora: app === 'meteora' ? withValue(valueUsd) : empty,
      spot: empty,
    },
  };
}

describe('staleAgeText', () => {
  it('0 whole minutes reads "less than a minute ago"', () => {
    assert.equal(staleAgeText(at(0), NOW), 'less than a minute ago');
    assert.equal(staleAgeText(at(0.5), NOW), 'less than a minute ago');
  });

  it('1 whole minute reads "1 minute ago"', () => {
    assert.equal(staleAgeText(at(1), NOW), '1 minute ago');
  });

  it('2 minutes reads "2 minutes ago"', () => {
    assert.equal(staleAgeText(at(2), NOW), '2 minutes ago');
  });

  it('59 minutes reads "59 minutes ago"', () => {
    assert.equal(staleAgeText(at(59), NOW), '59 minutes ago');
  });

  it('60 minutes reads "1 hour ago"', () => {
    assert.equal(staleAgeText(at(60), NOW), '1 hour ago');
  });

  it('120 minutes reads "2 hours ago"', () => {
    assert.equal(staleAgeText(at(120), NOW), '2 hours ago');
  });

  it('whole minutes never go below 0', () => {
    assert.equal(staleAgeText(at(-5), NOW), 'less than a minute ago');
  });

  it('an unparsable date reads "a while ago"', () => {
    assert.equal(staleAgeText('not-a-date', NOW), 'a while ago');
  });
});

describe('appIsStale', () => {
  it('held summary with a value and an error is stale', () => {
    assert.equal(appIsStale(summaryWith('phoenix', 1250), 'Network failed', 'phoenix'), true);
  });

  it('held summary without a value is not stale (the #865 failure shows)', () => {
    assert.equal(appIsStale(summaryWith('phoenix', null), 'Network failed', 'phoenix'), false);
  });

  it('no summary held is not stale, error or not', () => {
    assert.equal(appIsStale(null, 'Network failed', 'phoenix'), false);
    assert.equal(appIsStale(null, null, 'phoenix'), false);
  });

  it('held with the error cleared (a retry succeeded) is not stale', () => {
    assert.equal(appIsStale(summaryWith('phoenix', 1250), null, 'phoenix'), false);
  });

  it('checks exactly the named app slot, on all three app views', () => {
    assert.equal(appIsStale(summaryWith('pacifica', 1250), null, 'pacifica'), false);
    assert.equal(appIsStale(summaryWith('meteora', 1250), null, 'meteora'), false);
    assert.equal(
      appIsStale(summaryWith('phoenix', 1250), 'Network failed', 'pacifica'),
      false,
    );
    assert.equal(
      appIsStale(summaryWith('pacifica', 1250), 'Network failed', 'pacifica'),
      true,
    );
    assert.equal(
      appIsStale(summaryWith('meteora', 1250), 'Network failed', 'meteora'),
      true,
    );
  });
});
