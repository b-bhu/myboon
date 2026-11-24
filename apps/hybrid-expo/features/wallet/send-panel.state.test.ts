import assert from 'node:assert/strict';
import test from 'node:test';
import { walletSummaryFixture } from '@myboon/shared/wallet-summary';
import type { WalletSummary } from '@myboon/shared/wallet-summary';
import {
  SEND_USDC_MINT,
  balanceText,
  chipAmountText,
  sanitizeAmountText,
  spotUsdcAtomic,
} from './send-panel.state';

function summaryWithUsdc(valueUsd: number | null): WalletSummary {
  const base = structuredClone(walletSummaryFixture) as WalletSummary;
  base.apps.spot = {
    status: 'ok',
    valueUsd: 500,
    summary: {
      tokenCount: 1,
      tokens: [{ mint: SEND_USDC_MINT, symbol: 'USDC', iconUrl: null, valueUsd }],
    },
  };
  return base;
}

// Issue #822: chip amounts for a 250.5 USDC balance.
test('send chips: 25 / 50 / 75 / Max of the Spot USDC balance', () => {
  const atomic = spotUsdcAtomic(summaryWithUsdc(250.5));
  assert.equal(atomic, '250500000');
  assert.equal(chipAmountText(atomic!, 25), '62.625');
  assert.equal(chipAmountText(atomic!, 50), '125.25');
  assert.equal(chipAmountText(atomic!, 75), '187.875');
  // Max is the full balance.
  assert.equal(chipAmountText(atomic!, 100), '250.5');
  assert.equal(balanceText(atomic!), '250.5');
});

test('send chips: no Spot USDC means no balance (chips disabled)', () => {
  assert.equal(spotUsdcAtomic(null), null);
  assert.equal(spotUsdcAtomic(summaryWithUsdc(null)), null);

  const unavailable = summaryWithUsdc(10);
  unavailable.apps.spot = { status: 'unavailable', valueUsd: null, summary: null, error: 'down' };
  assert.equal(spotUsdcAtomic(unavailable), null);

  const notConnected = summaryWithUsdc(10);
  notConnected.apps.spot = { status: 'not_connected', valueUsd: null, summary: null };
  assert.equal(spotUsdcAtomic(notConnected), null);

  // Spot answers but holds no USDC.
  const noUsdc = summaryWithUsdc(10);
  noUsdc.apps.spot.summary!.tokens = [];
  assert.equal(spotUsdcAtomic(noUsdc), null);
});

test('send amount text: digits and one point, six decimals at most', () => {
  assert.equal(sanitizeAmountText('12a.5.5'), '12.55');
  assert.equal(sanitizeAmountText('1,5'), '1.5');
  assert.equal(sanitizeAmountText('0.1234567'), '0.123456');
  assert.equal(sanitizeAmountText(''), '');
});
