import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createSwapOrder,
  executeSwap,
  fetchSwapTokens,
  fetchTokenPrices,
  searchSwapTokens,
} from './swap.api';

test('all client Jupiter operations use the backend gateway without provider credentials', async () => {
  const originalFetch = globalThis.fetch;
  const names = ['EXPO_PUBLIC_API_BASE_URL', 'EXPO_PUBLIC_JUP_API_KEY', 'EXPO_PUBLIC_JUPITER_API_KEY', 'JUP_API_KEY'];
  const originalEnv = new Map(names.map((name) => [name, process.env[name]]));
  const requests: { url: URL; init?: RequestInit }[] = [];
  process.env.EXPO_PUBLIC_API_BASE_URL = 'https://gateway.example.test/api';
  for (const name of names.slice(1)) process.env[name] = 'fixture-provider-secret';
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push({ url, init });
    if (url.pathname.includes('/tokens')) return Response.json({ items: [] });
    if (url.pathname.endsWith('/prices')) return Response.json({ prices: [] });
    return Response.json({ requestId: 'fixture-order' });
  }) as typeof fetch;
  try {
    await fetchSwapTokens(1);
    await searchSwapTokens('USDC');
    await fetchTokenPrices(['fixture-mint']);
    await createSwapOrder({ inputMint: 'fixture-input', outputMint: 'fixture-output', amountAtomic: '1' });
    await createSwapOrder({ inputMint: 'fixture-input', outputMint: 'fixture-output', amountAtomic: '1', taker: 'fixture-wallet' });
    await executeSwap({ signedTransaction: 'fixture-signed', requestId: 'fixture-order', lastValidBlockHeight: '123' });
    assert.equal(requests.length, 6);
    for (const { url, init } of requests) {
      assert.equal(url.origin, 'https://gateway.example.test');
      assert.ok(url.pathname.startsWith('/api/swap/'));
      const headers = new Headers(init?.headers);
      assert.equal(headers.has('x-api-key'), false);
      assert.equal(headers.has('authorization'), false);
      assert.ok(headers.get('x-myboon-session'));
      assert.equal(JSON.stringify({ url: String(url), headers: [...headers], body: init?.body }).includes('fixture-provider-secret'), false);
    }
    const execution = requests.at(-1)!;
    assert.equal(execution.url.pathname, '/api/swap/execute');
    assert.equal(execution.init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(execution.init?.body)), {
      signedTransaction: 'fixture-signed', requestId: 'fixture-order', lastValidBlockHeight: '123',
    });
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of originalEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
