import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TokenIdentity } from './token-identity.core';
import { TokenIdentityStore } from './token-identity.store';

function identity(key: string, iconUrl: string | null = '/tokens/icon/sol'): TokenIdentity {
  return { key, iconUrl, assetId: null, symbol: 'SOL', name: 'Solana', decimals: 9,
    mint: key.slice(5), verified: true, category: 'crypto', fallbackLetter: 'S', source: 'static' };
}

test('catalog and resolves notify both mounted consumers, without redundant updates', async () => {
  const store = new TokenIdentityStore(async (refs) => refs.map((ref) => identity(ref)));
  let listUpdates = 0;
  let detailUpdates = 0;
  const unsubscribe = store.subscribe(() => { listUpdates += 1; });
  store.subscribe(() => { detailUpdates += 1; });
  store.seed([identity('mint:sol', null)]);
  await store.resolve(['mint:sol'], { force: true });
  assert.equal(store.snapshot(['mint:sol']).get('mint:sol')?.iconUrl, '/tokens/icon/sol');
  assert.equal(listUpdates, 2);
  assert.equal(detailUpdates, 2);
  store.seed([identity('mint:sol')]);
  assert.equal(listUpdates, 2);
  unsubscribe();
  store.seed([identity('mint:usdc')]);
  assert.equal(listUpdates, 2);
  assert.equal(detailUpdates, 3);
});

test('missing icons expire and forced refresh bypasses a previous failure', async () => {
  let now = 1;
  let requests = 0;
  let fail = false;
  const store = new TokenIdentityStore(async (refs) => {
    requests += 1;
    if (fail) throw new Error('network');
    return refs.map((ref) => identity(ref, requests === 1 ? null : '/tokens/icon/sol'));
  }, () => now);
  await store.resolve(['mint:sol']);
  await store.resolve(['mint:sol']);
  assert.equal(requests, 1);
  now += 30_001;
  await store.resolve(['mint:sol']);
  assert.equal(requests, 2);
  assert.ok(store.snapshot(['mint:sol']).get('mint:sol')?.iconUrl);
  fail = true;
  await store.resolve(['mint:new']);
  await store.resolve(['mint:new']);
  assert.equal(requests, 3);
  fail = false;
  await store.resolve(['mint:new'], { force: true });
  assert.equal(requests, 4);
});

test('overlapping list/detail requests share token requests, keeping cached icons during refresh', async () => {
  const batches: string[][] = [];
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  const store = new TokenIdentityStore(async (refs) => {
    batches.push([...refs]);
    await ready;
    return refs.map((ref) => identity(ref));
  });
  store.seed([identity('mint:sol')]);
  const list = store.resolve(['mint:sol', 'mint:usdc'], { force: true });
  const detail = store.resolve(['mint:sol', 'mint:other'], { force: true });
  assert.ok(store.snapshot(['mint:sol']).get('mint:sol')?.iconUrl);
  release();
  await Promise.all([list, detail]);
  assert.deepEqual(batches, [['mint:sol', 'mint:usdc'], ['mint:other']]);
  assert.deepEqual([...store.snapshot(['mint:other']).keys()], ['mint:other']);
  store.seed([identity('mint:sol', null)]);
  assert.ok(store.snapshot(['mint:sol']).get('mint:sol')?.iconUrl);
});
