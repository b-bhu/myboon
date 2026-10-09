import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchWalletActivity, isWalletActivityResult } from './wallet-activity.api';
import type { WalletActivityResult } from './wallet-activity.types';

const address = 'So11111111111111111111111111111111111111112';
const seed = { address, symbol: 'SOL', name: 'Solana' };
const fixture = (): WalletActivityResult => ({
  chain: 'solana', source: 'birdeye', status: 'ready', stale: false, partial: false,
  fetchedAt: '2026-10-08T10:00:00Z', nextRefreshAt: '2026-10-08T11:00:00Z',
  coverage: { tokens: [seed], walletCount: 1, limited: true, lookbackDays: 30 },
  activities: [{ id: 'swap-1', walletAddress: address, walletLabels: ['kol'], classificationToken: seed,
    action: 'buy', tokenAddress: address, tokenSymbol: 'SOL', amount: 1.25,
    priceUsd: null, valueUsd: 150, signature: '5'.repeat(88), observedAt: '2026-09-20T14:00:00Z' }],
});

test('wallet activity keeps actual dates and unknown values; rejects unsupported or inconsistent identity/coverage', () => {
  const valid = fixture();
  assert.equal(isWalletActivityResult(valid), true);
  for (const mutate of [
    (data: WalletActivityResult) => { data.activities[0]!.amount = 0; },
    (data: WalletActivityResult) => { data.activities[0]!.priceUsd = NaN; },
    (data: WalletActivityResult) => { data.activities[0]!.signature = 'https://example.com'; },
    (data: WalletActivityResult) => { data.activities[0]!.observedAt = 'unknown'; },
    (data: WalletActivityResult) => { data.activities.push(data.activities[0]!); },
    (data: WalletActivityResult) => { data.activities[0]!.walletLabels = ['kol', 'kol']; },
    (data: WalletActivityResult) => { data.coverage.tokens = []; },
    (data: WalletActivityResult) => { data.coverage.walletCount = 4; },
    (data: WalletActivityResult) => { data.activities[0]!.classificationToken = { ...seed, address: '11111111111111111111111111111111' }; data.coverage.tokens.push(data.activities[0]!.classificationToken); },
    (data: WalletActivityResult) => { data.stale = true; },
  ]) {
    const invalid = structuredClone(valid);
    mutate(invalid);
    assert.equal(isWalletActivityResult(invalid), false);
  }
  assert.equal(isWalletActivityResult({ ...valid, source: 'jupiter' }), false);
  assert.equal(isWalletActivityResult({ ...valid, status: 'partial', partial: false }), false);
});

test('API decoder separates healthy empty, partial, stale and unavailable; rejects HTTP/contract mismatches', async () => {
  const original = globalThis.fetch;
  let payload: unknown = { ...fixture(), activities: [] };
  let status = 200;
  let requested = '';
  globalThis.fetch = async (input) => { requested = String(input); return Response.json(payload, { status }); };
  try {
    assert.deepEqual((await fetchWalletActivity()).activities, []);
    assert.equal(new URL(requested).pathname, '/market/wallet-activity');
    payload = { ...fixture(), status: 'partial', partial: true };
    assert.equal((await fetchWalletActivity()).status, 'partial');
    payload = { ...fixture(), status: 'stale', stale: true, partial: true };
    assert.equal((await fetchWalletActivity()).status, 'stale');
    payload = { ...fixture(), status: 'unavailable', fetchedAt: null, activities: [], error: { code: 'ACCESS_DENIED', retryable: false, message: 'Unavailable' } };
    status = 503;
    assert.equal((await fetchWalletActivity()).error?.retryable, false);
    status = 200;
    await assert.rejects(fetchWalletActivity(), /could not be loaded/);
    status = 503;
    payload = fixture();
    await assert.rejects(fetchWalletActivity(), /could not be loaded/);
    status = 200;
    payload = { success: true, data: [] };
    await assert.rejects(fetchWalletActivity(), /could not be loaded/);
  } finally { globalThis.fetch = original; }
});

test('leaving the screen cancels the wallet activity request', async () => {
  const original = globalThis.fetch;
  let sentSignal: AbortSignal | null | undefined;
  globalThis.fetch = async (_input, options) => {
    sentSignal = options?.signal;
    return new Promise((_resolve, reject) => {
      sentSignal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
  };
  try {
    const controller = new AbortController();
    const pending = fetchWalletActivity(controller.signal);
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(sentSignal?.aborted, true);
  } finally { globalThis.fetch = original; }
});
