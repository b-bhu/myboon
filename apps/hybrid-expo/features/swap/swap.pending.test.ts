import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemorySwapPendingStorage, createSwapPendingStore } from './swap.pending';
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
