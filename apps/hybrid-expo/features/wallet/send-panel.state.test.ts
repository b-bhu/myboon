import assert from 'node:assert/strict';
import test from 'node:test';
import { walletSummaryFixture } from '@myboon/shared/wallet-summary';
import type { WalletSummary } from '@myboon/shared/wallet-summary';
import {
  SEND_USDC_MINT,
  balanceText,
  rentLineText,
  sendAmountAtomic,
  sendInputsLocked,
  sendAmountLabel,
  sendSliderCopy,
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

// Issue #825: slider copy for every state, wording from the frames.
test('send slider copy: off, ready, pending, done, failed', () => {
  const base = { ready: true, amount: '12.5', address: '7xKXtgAbcdefghijkmnopqrstuvwxyz123TZRuJosgAsU' };
  assert.deepEqual(sendSliderCopy({ ...base, ready: false, stage: 'idle' }), {
    small: 'Swipe to send',
    strong: 'Enter an address and amount',
  });
  assert.deepEqual(sendSliderCopy({ ...base, stage: 'idle' }), {
    small: 'Swipe to send',
    strong: '12.5 USDC to 7xKX…gAsU',
  });
  assert.deepEqual(sendSliderCopy({ ...base, stage: 'pending' }), { small: 'Step 1 of 1', strong: 'Sending...' });
  assert.deepEqual(sendSliderCopy({ ...base, stage: 'done', tookSeconds: 2 }), {
    small: 'Done · ~$0.001 fees · took 2s',
    strong: 'Sent · 12.5 USDC',
  });
  assert.deepEqual(sendSliderCopy({ ...base, stage: 'failed' }), {
    small: 'Send failed · money is safe',
    strong: 'Slide to retry',
  });
});

test('send helpers: amount to atomic, rent line', () => {
  assert.equal(sendAmountAtomic('12.5'), '12500000');
  assert.equal(sendAmountAtomic(''), null);
  assert.equal(sendAmountAtomic('0'), null);
  assert.equal(sendAmountLabel('12500000'), '12.5');
  assert.equal(rentLineText(2039280), 'Includes ~0.002 SOL to create their USDC account');
});

test('send inputs lock only while a send is pending', () => {
  assert.equal(sendInputsLocked('pending'), true);
  for (const stage of ['idle', 'done', 'failed'] as const) assert.equal(sendInputsLocked(stage), false);
});
