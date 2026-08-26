import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPreparedWithdrawal,
  markWithdrawalAmbiguous,
  markWithdrawalSubmitted,
  markWithdrawalSubmitting,
  reconcileWithdrawalTracking,
} from './withdrawalTracking';
import type { BridgeQuote } from './predict.api';

const quote: BridgeQuote = {
  quoteId: 'quote',
  estCheckoutTimeMs: 60_000,
  estInputUsd: 25,
  estOutputUsd: 24.99,
  estToTokenBaseUnit: '24990000',
  estFeeBreakdown: {
    appFeePercent: null, appFeeUsd: null, fillCostPercent: null, fillCostUsd: null,
    gasUsd: null, maxSlippage: null, minReceived: 24.98, swapImpact: 0.01,
    totalImpact: 0.04, totalImpactUsd: 0.01,
  },
};

test('accepted transfer timeout survives serialization and reconciles after restart', () => {
  const prepared = createPreparedWithdrawal({
    amount: 25,
    recipientAddress: 'solana-recipient',
    bridgeAddress: '0xbridge',
    quote,
    now: 1_000,
  });
  assert.equal(prepared.status, 'PREPARED');
  assert.equal(prepared.bridgeAddress, '0xbridge');

  const submitting = markWithdrawalSubmitting(prepared, 1_100);
  const submitted = markWithdrawalSubmitted(submitting, 'relayer-123', '0xhash', 1_200);
  const timedOut = markWithdrawalAmbiguous(submitted, 'Confirmation timed out.', 1_300);
  const restored = JSON.parse(JSON.stringify(timedOut)) as typeof timedOut;

  assert.equal(restored.status, 'AMBIGUOUS');
  assert.equal(restored.transactionId, 'relayer-123');
  assert.equal(restored.bridgeAddress, '0xbridge');

  const relayed = reconcileWithdrawalTracking(restored, [], {
    state: 'STATE_CONFIRMED',
    transactionId: 'relayer-123',
    transactionHash: '0xhash',
    errorMessage: null,
  }, 1_400);
  assert.equal(relayed.status, 'BRIDGING');

  const completed = reconcileWithdrawalTracking(relayed, [{
    status: 'COMPLETED',
    fromAmountBaseUnit: '25000000',
    txHash: '0xbridgehash',
    createdTimeMs: 2_000,
  }], null, 2_100);
  assert.equal(completed.status, 'COMPLETED');
  assert.equal(completed.transactionHash, '0xbridgehash');
});

test('only authoritative relayer or Bridge failure makes a withdrawal retryable', () => {
  const prepared = createPreparedWithdrawal({
    amount: 25, recipientAddress: 'recipient', bridgeAddress: '0xbridge', quote, now: 1_000,
  });
  const ambiguous = markWithdrawalAmbiguous(markWithdrawalSubmitting(prepared), 'Network lost');
  assert.equal(reconcileWithdrawalTracking(ambiguous, [], null).status, 'AMBIGUOUS');
  assert.equal(reconcileWithdrawalTracking(ambiguous, [], {
    state: 'STATE_FAILED', transactionId: 'relayer-1', transactionHash: null, errorMessage: 'reverted',
  }).status, 'FAILED');
});
