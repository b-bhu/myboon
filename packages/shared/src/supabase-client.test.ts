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

test('createTimeoutFetch reports the timeout cause and never logs credentials', async () => {
  // AbortSignal.timeout timers are unref'd, so hold the event loop open until
  // the abort fires or this test would drain before the timeout runs.
  const keepEventLoopAlive = setTimeout(() => {}, 5_000)
  const messages: string[] = []
  try {
    const timed = createTimeoutFetch(50, hangingNeverResolves(), {
      logger: (message) => { messages.push(message) },
    })
    await assert.rejects(
      timed('https://example.test/rest/v1/entity_memories?apikey=secret&select=*'),
      (err) => errorName(err) === 'TimeoutError',
    )
    assert.equal(messages.length, 1)
    const line = messages[0] ?? ''
    assert.ok(line.startsWith('[supabase] request failed '), line)
    assert.ok(line.includes('"cause":"timeout"'), line)
    assert.ok(line.includes('"timeoutMs":50'), line)
    assert.ok(line.includes('"method":"GET"'), line)
    assert.ok(line.includes('"path":"/rest/v1/entity_memories"'), line)
    // Path only: no host, no query string, no apikey.
    assert.ok(!line.includes('example.test'), line)
    assert.ok(!line.includes('secret'), line)
  } finally {
    clearTimeout(keepEventLoopAlive)
  }
})

test('createTimeoutFetch reports a caller abort as cause "aborted" and rethrows unchanged', async () => {
  const messages: string[] = []
  const controller = new AbortController()
  const pending = createTimeoutFetch(10_000, hangingNeverResolves(), {
    logger: (message) => { messages.push(message) },
  })('http://example.test/rows', { signal: controller.signal })
  controller.abort()
  let caught: unknown
  try {
    await pending
  } catch (error) {
    caught = error
  }
  assert.equal(messages.length, 1)
  assert.ok((messages[0] ?? '').includes('"cause":"aborted"'), messages[0])
  // The caller receives the very error object the wrapper caught.
  assert.equal(caught, controller.signal.reason)
})

test('createTimeoutFetch reports a refused connection as cause "connection_refused"', async () => {
  const messages: string[] = []
  // Same shape undici raises on a refused connect: TypeError wrapping an
  // errno Error in `cause`.
  const cause = new Error('connect ECONNREFUSED 127.0.0.1:5432')
  ;(cause as { code?: string }).code = 'ECONNREFUSED'
  const fetchFailed = new TypeError('fetch failed', { cause })
  const refusing = ((input: unknown, init: unknown): Response => {
    throw fetchFailed
  }) as unknown as typeof fetch
  const timed = createTimeoutFetch(1_000, refusing, {
    logger: (message) => { messages.push(message) },
  })

  let caught: unknown
  try {
    await timed('http://127.0.0.1:5432/rest/v1/rows', { method: 'POST' })
  } catch (error) {
    caught = error
  }
  assert.equal(caught, fetchFailed)
  assert.equal(messages.length, 1)
  const line = messages[0] ?? ''
  assert.ok(line.startsWith('[supabase] request failed '), line)
  assert.ok(line.includes('"cause":"connection_refused"'), line)
  assert.ok(line.includes('"timeoutMs":1000'), line)
  assert.ok(line.includes('"method":"POST"'), line)
  assert.ok(line.includes('"path":"/rest/v1/rows"'), line)
})

test('createTimeoutFetch classifies any other rejection as cause "other"', async () => {
  const messages: string[] = []
  const boom = new Error('boom')
  const failing = ((input: unknown, init: unknown): Response => {
    throw boom
  }) as unknown as typeof fetch
  const timed = createTimeoutFetch(1_000, failing, {
    logger: (message) => { messages.push(message) },
  })

  let caught: unknown
  try {
    await timed('http://example.test/rows')
  } catch (error) {
    caught = error
  }
  assert.equal(caught, boom)
  assert.equal(messages.length, 1)
  assert.ok((messages[0] ?? '').includes('"cause":"other"'), messages[0])
  assert.ok(!(messages[0] ?? '').includes('"cause":"timeout"'), messages[0])
  assert.ok(!(messages[0] ?? '').includes('"cause":"aborted"'), messages[0])
  assert.ok(!(messages[0] ?? '').includes('"cause":"connection_refused"'), messages[0])
})

test('createSupabaseClient forwards the injected logger to its timeout fetch', async () => {
  const messages: string[] = []
  const supabase = createSupabaseClient('https://example.test', 'anon-key', {
    timeoutMs: 50,
    logger: (message) => { messages.push(message) },
    fetch: hangingNeverResolves(),
  })
  // AbortSignal.timeout timers are unref'd, so hold the event loop open until
  // the abort fires or this test would drain before the timeout runs.
  const keepEventLoopAlive = setTimeout(() => {}, 5_000)
  try {
    // postgrest-js resolves fetch failures into its `error` field rather
    // than rejecting, so assert on the resolved error.
    const { error } = await supabase.from('rows').select('*')
    assert.ok(error, 'expected the aborted request to surface as a Postgrest error')
  } finally {
    clearTimeout(keepEventLoopAlive)
  }
  assert.equal(messages.length, 1)
  assert.ok((messages[0] ?? '').includes('"cause":"timeout"'), messages[0])
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