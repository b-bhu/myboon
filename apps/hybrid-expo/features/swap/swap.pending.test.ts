import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createMemorySwapPendingStorage,
  createSwapPendingStore,
  isPendingSwapExpired,
  shouldDiscardExpiredPendingSwap,
} from './swap.pending';
import type { PendingSwapExecution } from './swap.types';

function pending(requestId: string, walletAddress = 'wallet-a'): PendingSwapExecution {
  return {
    version: 1,
    requestId,
    walletAddress,
    inputMint: 'input',
    outputMint: 'output',
    inAmountAtomic: '1',
    minimumOutAmountAtomic: '1',
    signature: null,
    lastValidBlockHeight: '123',
    outcome: 'submitted',
    createdAt: '2026-08-18T00:00:00.000Z',
    updatedAt: '2026-08-18T00:00:00.000Z',
  };
}

test('persists, scopes, updates, and removes pending swaps', async () => {
  const store = createSwapPendingStore(createMemorySwapPendingStorage());
  await store.save(pending('one'));
  await store.save(pending('two', 'wallet-b'));
  assert.deepEqual((await store.list('wallet-a')).map((row) => row.requestId), ['one']);

  await store.save({ ...pending('one'), outcome: 'unknown', signature: 'signature' });
  assert.equal((await store.list('wallet-a'))[0].outcome, 'unknown');
  await store.remove('one');
  assert.equal((await store.list('wallet-a')).length, 0);
});

test('pending swap expiry is strict and rejects malformed validity windows', () => {
  assert.equal(isPendingSwapExpired({ lastValidBlockHeight: '100' }, 100), false);
  assert.equal(isPendingSwapExpired({ lastValidBlockHeight: '100' }, 101), true);
  assert.equal(isPendingSwapExpired({ lastValidBlockHeight: null }, 101), false);
  assert.equal(isPendingSwapExpired({ lastValidBlockHeight: 'not-a-height' }, 101), false);
});

test('only discards an expired pending swap that Solana has never observed', () => {
  const value = { lastValidBlockHeight: '100' };
  assert.equal(shouldDiscardExpiredPendingSwap(value, 101, false), true);
  assert.equal(shouldDiscardExpiredPendingSwap(value, 101, true), false);
  assert.equal(shouldDiscardExpiredPendingSwap(value, 100, false), false);
  assert.equal(shouldDiscardExpiredPendingSwap(value, null, false), false);
});
