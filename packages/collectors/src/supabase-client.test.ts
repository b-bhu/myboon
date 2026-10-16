import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createSupabaseClient,
  createTimeoutFetch,
  DEFAULT_SUPABASE_FETCH_TIMEOUT_MS,
} from './supabase-client'

function fetchCallsCollector(): { fetch: typeof fetch; calls: Array<{ input: unknown; init?: RequestInit }> } {
  const calls: Array<{ input: unknown; init?: RequestInit }> = []
  return {
    calls,
    fetch: ((input, init) => {
      calls.push({ input, init })
      return Promise.resolve(new Response('{"ok":true}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
    }) as typeof fetch,
  }
}

function hangingNeverResolves(): typeof fetch {
  return ((input, init) => new Promise<Response>((_, reject) => {
    const signal = init?.signal
    signal?.addEventListener('abort', () => reject(signal.reason))
  })) as typeof fetch
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : 'unexpected'
}

test('default Supabase fetch timeout is 10 seconds', () => {
  assert.equal(DEFAULT_SUPABASE_FETCH_TIMEOUT_MS, 10_000)
})

test('createTimeoutFetch aborts a hanging request after the timeout', async () => {
  // AbortSignal.timeout timers are unref'd, so hold the event loop open until
  // the abort fires or this test would drain before the timeout runs.
  const keepEventLoopAlive = setTimeout(() => {}, 5_000)
  try {
    const timed = createTimeoutFetch(50, hangingNeverResolves())
    await assert.rejects(timed('http://example.test/rows'), (err) => errorName(err) === 'TimeoutError')
  } finally {
    clearTimeout(keepEventLoopAlive)
  }
})

test('createTimeoutFetch still honours a caller-provided abort signal', async () => {
  const controller = new AbortController()
  const pending = assert.rejects(
    createTimeoutFetch(10_000, hangingNeverResolves())('http://example.test/rows', { signal: controller.signal }),
    (err) => errorName(err) === 'AbortError',
  )
  controller.abort()
  await pending
})

test('createTimeoutFetch passes a normal response through and forwards init', async () => {
  const { fetch, calls } = fetchCallsCollector()
  const timed = createTimeoutFetch(1_000, fetch)

  const response = await timed('http://example.test/rows', { headers: { Authorization: 'Bearer test' } })

  assert.equal(response.status, 200)
  assert.equal(await response.text(), '{"ok":true}')
  assert.equal(calls.length, 1)
  assert.equal((calls[0]?.init?.headers as Record<string, string> | undefined)?.Authorization, 'Bearer test')
  // The wrapper injects a bounded signal even when the caller passes none.
  assert.ok(calls[0]?.init?.signal instanceof AbortSignal)
})

test('createSupabaseClient rejects an invalid timeoutMs', () => {
  for (const invalidTimeout of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => createSupabaseClient('https://example.test', 'anon-key', { timeoutMs: invalidTimeout }),
      /positive finite integer/,
      `expected throw for timeoutMs: ${String(invalidTimeout)}`,
    )
  }
})

test('createSupabaseClient builds a client whose requests go through the timeout fetch', async () => {
  const { fetch, calls } = fetchCallsCollector()
  const supabase = createSupabaseClient('https://example.test', 'anon-key', { fetch })

  const { error } = await supabase.from('rows').select('*')

  assert.equal(error, null)
  assert.equal(calls.length, 1)
  // Every client request arrives at the base fetch already bounded by the wrapper.
  assert.ok(calls[0]?.init?.signal instanceof AbortSignal)
})