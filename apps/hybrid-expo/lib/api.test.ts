import assert from 'node:assert/strict';
import test from 'node:test';

import { fetchWithTimeout } from './api';

test('fetchWithTimeout forwards a caller abort and rejects the active request', async () => {
  const originalFetch = globalThis.fetch;
  const caller = new AbortController();

  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => (
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    })
  )) as typeof fetch;

  try {
    const request = fetchWithTimeout('https://example.com/candles', {
      signal: caller.signal,
      timeoutMs: 5_000,
    });
    caller.abort();
    await assert.rejects(request, (error: unknown) => (
      error instanceof DOMException && error.name === 'AbortError'
    ));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchWithTimeout forwards a signal that was already aborted', async () => {
  const originalFetch = globalThis.fetch;
  const caller = new AbortController();
  caller.abort();
  let receivedAbortedSignal = false;

  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    receivedAbortedSignal = init?.signal?.aborted === true;
    return new Response('{}', { status: 200 });
  }) as typeof fetch;

  try {
    await fetchWithTimeout('https://example.com/candles', {
      signal: caller.signal,
    });
    assert.equal(receivedAbortedSignal, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
