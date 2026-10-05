import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MeteoraPoolDetail } from '@myboon/shared/meteora';
import type { MeteoraPhaseTwoPreview } from './meteora.form';
import { isMeteoraReviewCurrent, type MeteoraPositionReview } from './meteora.review';

const nowMs = Date.parse('2026-10-03T12:00:00Z');
const preview: MeteoraPhaseTwoPreview = {
  id: 'quote-1',
  kind: 'position',
  createdAt: new Date(nowMs).toISOString(),
  expiresAt: new Date(nowMs + 30_000).toISOString(),
  currentPrice: '120',
  transactionCount: 1,
  costs: [{ label: 'Network fee', value: '0.000005 SOL' }],
  warnings: [],
  canExecute: true,
  walletAddress: 'wallet-1',
  network: 'mainnet-beta',
};
const review: MeteoraPositionReview = {
  pool: { address: 'pool-1' } as MeteoraPoolDetail,
  preview,
  inputKey: 'draft-1',
  walletAddress: 'wallet-1',
  amountX: '1',
  amountY: '120',
  strategy: 'spot',
  inverted: false,
  addMode: false,
};
const context = { inputKey: 'draft-1', poolAddress: 'pool-1', walletAddress: 'wallet-1', ready: true, nowMs };

test('a reviewed quote stays confirmable only until its expiry', () => {
  assert.equal(isMeteoraReviewCurrent(review, preview, context), true);
  assert.equal(isMeteoraReviewCurrent(review, preview, { ...context, nowMs: nowMs + 30_000 }), false);
});

test('a replacement quote requires a new review even if it reuses the same ID', () => {
  const replacement = { ...preview, costs: [{ label: 'Network fee', value: '0.00001 SOL' }] };
  assert.equal(isMeteoraReviewCurrent(review, replacement, context), false);
  assert.equal(isMeteoraReviewCurrent({ ...review, preview: replacement }, replacement, context), true);
});

test('changes to the draft, pool, wallet, or execution readiness block an open review', () => {
  for (const change of [
    { inputKey: 'draft-2' },
    { poolAddress: 'pool-2' },
    { walletAddress: 'wallet-2' },
    { walletAddress: null },
    { ready: false },
  ]) {
    assert.equal(isMeteoraReviewCurrent(review, preview, { ...context, ...change }), false);
  }
  assert.equal(isMeteoraReviewCurrent(review, null, context), false);
});

test('blocking warnings and malformed expiry cannot be confirmed', () => {
  for (const change of [
    { warnings: [{ code: 'BLOCKED', message: 'Action required', blocking: true }] },
    { expiresAt: 'invalid' },
    { canExecute: false },
  ]) {
    const blocked = { ...preview, ...change };
    assert.equal(isMeteoraReviewCurrent({ ...review, preview: blocked }, blocked, context), false);
  }
});
