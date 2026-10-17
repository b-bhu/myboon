import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createSupabaseClient,
  createSupabaseHealthProbe,
  createTimeoutFetch,
  DEFAULT_SUPABASE_FETCH_TIMEOUT_MS,
  probeSupabaseHealth,
  requireSupabaseEnv,
  SUPABASE_HEALTH_PROBE_TIMEOUT_MS,
} from './supabase-client'
import type { SupabaseClient } from '@supabase/supabase-js'

function fetchResponding(response: Response): typeof fetch {
  return (() => Promise.resolve(response)) as unknown as typeof fetch
}

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

test('createTimeoutFetch logs statement_timeout for a PostgREST 57014 response and passes it through', async () => {
  const messages: string[] = []
  const timed = createTimeoutFetch(1_000, fetchResponding(new Response(JSON.stringify({
    code: '57014',
    message: 'canceling statement due to statement timeout',
    details: null,
    hint: null,
  }), {
    status: 500,
    headers: { 'Content-Type': 'application/json' },
  })), {
    logger: (message) => { messages.push(message) },
  })

  const response = await timed('https://example.test/rest/v1/entity_memories?apikey=secret&select=*', { method: 'POST' })

  // The original response comes back unchanged and its body is still readable.
  assert.equal(response.status, 500)
  assert.equal(((await response.json()) as { code: string }).code, '57014')

  assert.equal(messages.length, 1)
  const line = messages[0] ?? ''
  assert.ok(line.startsWith('[supabase] request failed '), line)
  assert.ok(line.includes('"cause":"statement_timeout"'), line)
  assert.ok(line.includes('"timeoutMs":1000'), line)
  assert.ok(line.includes('"method":"POST"'), line)
  assert.ok(line.includes('"path":"/rest/v1/entity_memories"'), line)
  assert.ok(line.includes('"status":500'), line)
  // Path only: no host, no query string, no apikey.
  assert.ok(!line.includes('example.test'), line)
  assert.ok(!line.includes('secret'), line)
})

test('createTimeoutFetch logs nothing for other non-ok PostgREST responses', async () => {
  const messages: string[] = []
  const timed = createTimeoutFetch(1_000, fetchResponding(new Response(JSON.stringify({
    code: '42501',
    message: 'permission denied for table rows',
  }), {
    status: 400,
    headers: { 'Content-Type': 'application/json' },
  })), {
    logger: (message) => { messages.push(message) },
  })

  const response = await timed('http://example.test/rows')

  assert.equal(response.status, 400)
  assert.ok((await response.text()).includes('42501'))
  assert.equal(messages.length, 0)
})

test('createTimeoutFetch logs nothing and does not throw on a non-JSON error body', async () => {
  const messages: string[] = []
  const timed = createTimeoutFetch(1_000, fetchResponding(new Response('<html>Bad Gateway</html>', {
    status: 502,
    headers: { 'Content-Type': 'text/html' },
  })), {
    logger: (message) => { messages.push(message) },
  })

  const response = await timed('http://example.test/rows')

  assert.equal(response.status, 502)
  assert.equal(await response.text(), '<html>Bad Gateway</html>')
  assert.equal(messages.length, 0)
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

test('createSupabaseClient rejects a blank or missing url and key', () => {
  assert.throws(() => createSupabaseClient('', 'anon-key'), /createSupabaseClient: supabaseUrl is required/)
  assert.throws(() => createSupabaseClient('   ', 'anon-key'), /createSupabaseClient: supabaseUrl is required/)
  assert.throws(() => createSupabaseClient('https://example.test', ''), /createSupabaseClient: supabaseKey is required/)
  assert.throws(() => createSupabaseClient('https://example.test', '  '), /createSupabaseClient: supabaseKey is required/)
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

test('requireSupabaseEnv returns the trimmed url and key when both are set', () => {
  assert.deepEqual(
    requireSupabaseEnv({
      SUPABASE_URL: '  https://example.test  ',
      SUPABASE_SERVICE_ROLE_KEY: ' service-role-key ',
    }),
    { supabaseUrl: 'https://example.test', supabaseKey: 'service-role-key' },
  )
})

test('requireSupabaseEnv names every missing or blank key and never prints values', () => {
  assert.throws(
    () => requireSupabaseEnv({}),
    /Missing required Supabase env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY/,
  )
  // Whitespace-only values count as blank.
  assert.throws(
    () => requireSupabaseEnv({ SUPABASE_URL: '   ', SUPABASE_SERVICE_ROLE_KEY: '' }),
    /Missing required Supabase env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY/,
  )
  assert.throws(
    () => requireSupabaseEnv({ SUPABASE_SERVICE_ROLE_KEY: 'secret-service-role-key' }),
    /^Error: Missing required Supabase env: SUPABASE_URL$/,
  )
  try {
    requireSupabaseEnv({ SUPABASE_URL: 'https://secret.example.test' })
    assert.ok(false, 'expected requireSupabaseEnv to throw')
  } catch (error) {
    assert.ok(error instanceof Error)
    assert.equal(error.message, 'Missing required Supabase env: SUPABASE_SERVICE_ROLE_KEY')
    // Values must not leak into the message.
    assert.ok(!error.message.includes('secret'), error.message)
  }
})

test('the Supabase health probe timeout default is 5 seconds', () => {
  assert.equal(SUPABASE_HEALTH_PROBE_TIMEOUT_MS, 5_000)
})

type ProbeCall = { table: string; select?: string; count: string | null; limit?: number }

/** Minimal `Pick<SupabaseClient, 'from'>` capturing the exact query shape the probe must issue. */
function fakeProbeClient(result: { data: unknown; error: unknown }): {
  client: Pick<SupabaseClient, 'from'>
  calls: ProbeCall[]
} {
  const calls: ProbeCall[] = []
  const client = {
    from(table: string) {
      const call: ProbeCall = { table, select: undefined, count: null, limit: undefined }
      calls.push(call)
      const builder = {
        select: (columns: string, options?: { count?: string }) => {
          call.select = columns
          call.count = options?.count ?? null
          return builder
        },
        limit: (value: number) => {
          call.limit = value
          return builder
        },
        then: (
          onFulfilled?: (value: { data: unknown; error: unknown }) => unknown,
          onRejected?: (error: unknown) => unknown,
        ) => Promise.resolve(result).then(onFulfilled, onRejected),
      }
      return builder
    },
  } as unknown as Pick<SupabaseClient, 'from'>
  return { client, calls }
}

test('probeSupabaseHealth resolves on success with one small pipeline_runs id read and no count', async () => {
  const { client, calls } = fakeProbeClient({ data: [{ id: 1 }], error: null })

  await probeSupabaseHealth(client)

  assert.deepEqual(calls, [{ table: 'pipeline_runs', select: 'id', count: null, limit: 1 }])
})

test('probeSupabaseHealth throws one error naming the probe, with the code copied and the original as cause', async () => {
  const postgrestError = { message: 'permission denied for table pipeline_runs', code: '42501' }
  const { client } = fakeProbeClient({ data: null, error: postgrestError })

  let caught: unknown
  try {
    await probeSupabaseHealth(client)
    assert.ok(false, 'expected probeSupabaseHealth to reject')
  } catch (error) {
    caught = error
  }

  assert.ok(caught instanceof Error)
  assert.equal(caught.message, 'Supabase health probe failed: permission denied for table pipeline_runs')
  assert.equal((caught as { code?: string }).code, '42501')
  assert.equal((caught as { cause?: unknown }).cause, postgrestError)
})

test('probeSupabaseHealth omits the code property when the error carries none', async () => {
  const { client } = fakeProbeClient({ data: null, error: { message: 'socket hang up' } })

  try {
    await probeSupabaseHealth(client)
    assert.ok(false, 'expected probeSupabaseHealth to reject')
  } catch (error) {
    assert.ok(error instanceof Error)
    assert.equal(error.message, 'Supabase health probe failed: socket hang up')
    assert.equal((error as { code?: string }).code, undefined)
  }
})

test('createSupabaseHealthProbe rejects a hung Supabase within its timeout and never leaks credentials', async () => {
  // AbortSignal.timeout timers are unref'd, so hold the event loop open until
  // the abort fires or this test would drain before the timeout runs.
  const keepEventLoopAlive = setTimeout(() => {}, 5_000)
  try {
    const probe = createSupabaseHealthProbe('https://secret-host.example.test', 'service-role-secret', {
      timeoutMs: 50,
      fetch: hangingNeverResolves(),
    })

    let caught: unknown
    try {
      await probe()
      assert.ok(false, 'expected the hanging probe to reject')
    } catch (error) {
      caught = error
    }

    assert.ok(caught instanceof Error, `expected an Error, got: ${String(caught)}`)
    const message = (caught as Error).message
    assert.ok(message.length > 0, 'the rejection carries a message')
    // The message names the failure, never the URL or the key.
    assert.ok(!message.includes('secret-host.example.test'), message)
    assert.ok(!message.includes('service-role-secret'), message)
  } finally {
    clearTimeout(keepEventLoopAlive)
  }
})