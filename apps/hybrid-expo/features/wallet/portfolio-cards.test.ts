/**
 * Tests for the Portfolio Cards chip helpers (issue #842): which field feeds
 * each app's chip, and the chip text. Pure scenarios only.
 *
 * Run: pnpm --filter hybrid-expo test:wallet
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { walletSummaryFixture, type WalletSummary } from '@myboon/shared/wallet-summary';

import { pnlChipText, portfolioCardPnl } from './portfolio-cards';

function scenario(): WalletSummary {
  return structuredClone(walletSummaryFixture);
}

describe('pnlChipText', () => {
  it('signs and formats the P&L; null shows no chip', () => {
    assert.equal(pnlChipText(18), '+$18.00');
    assert.equal(pnlChipText(-6), '-$6.00');
    assert.equal(pnlChipText(0), '+$0.00');
    assert.equal(pnlChipText(null), null);
  });
});

describe('portfolioCardPnl', () => {
  it('reads each app from its own field', () => {
    const s = scenario();
    s.apps.polymarket.summary!.totalPnlUsd = 18;
    s.apps.phoenix.summary!.unrealizedPnlUsd = 24;
    s.apps.pacifica.summary!.unrealizedPnlUsd = -6;
    s.apps.meteora.summary!.totalPnlUsd = 5;
    assert.equal(portfolioCardPnl(s, 'polymarket'), 18);
    assert.equal(portfolioCardPnl(s, 'phoenix'), 24);
    assert.equal(portfolioCardPnl(s, 'pacifica'), -6);
    assert.equal(portfolioCardPnl(s, 'meteora'), 5);
  });

  it('Meteora with a null total P&L has none (no chip)', () => {
    const s = scenario();
    s.apps.meteora.summary!.totalPnlUsd = null;
    assert.equal(portfolioCardPnl(s, 'meteora'), null);
  });

  it('an app that is not ok has none', () => {
    const s = scenario();
    s.apps.phoenix.status = 'unavailable';
    assert.equal(portfolioCardPnl(s, 'phoenix'), null);
  });
});
