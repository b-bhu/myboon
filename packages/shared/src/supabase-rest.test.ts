import assert from 'node:assert/strict'
import test from 'node:test'

import { createSupabaseRest } from './supabase-rest'

interface RecordedCall {
  url: URL
  init?: RequestInit
}

/** One fake fetch that records every call and answers through `responder`. */
function collector(responder: (call: RecordedCall) => Response): {
  fetch: typeof fetch
  calls: RecordedCall[]
} {
  const calls: RecordedCall[] = []
  const fetchFn: typeof fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const call: RecordedCall = { url, init }
    calls.push(call)
    return Promise.resolve(responder(call))
  }
  return { fetch: fetchFn, calls }
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers })
}

function headersOf(call: RecordedCall | undefined): Record<string, string> {
  return (call?.init?.headers ?? {}) as Record<string, string>
}

test('readRows requests the rest/v1 table URL with the auth and Accept headers', async () => {
  const { fetch, calls } = collector(() => jsonResponse([{ id: 1 }]))
  const rest = createSupabaseRest({
    supabaseUrl: 'https://project.supabase.co/',
    serviceRoleKey: 'service-role-test-key',
    fetch,
  })

  const rows = await rest.readRows('entities', new URLSearchParams({ select: 'id', status: 'eq.active' }))

  assert.deepEqual(rows, [{ id: 1 }])
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.url.toString(), 'https://project.supabase.co/rest/v1/entities?select=id&status=eq.active')
  const headers = headersOf(calls[0])
  assert.equal(headers.apikey, 'service-role-test-key')
  assert.equal(headers.Authorization, 'Bearer service-role-test-key')
  assert.equal(headers.Accept, 'application/json')
  assert.ok(calls[0]?.init?.signal instanceof AbortSignal)
})

test('readRows sends Accept-Profile atlas only when the atlas schema is selected', async () => {
  const { fetch, calls } = collector(() => jsonResponse([]))
  const rest = createSupabaseRest({
    supabaseUrl: 'https://project.supabase.co',
    serviceRoleKey: 'service-role-test-key',
    fetch,
  })

  await rest.readRows('entities', new URLSearchParams({ select: 'id' }), 'atlas')
  await rest.readRows('entities', new URLSearchParams({ select: 'id' }))

  assert.equal(headersOf(calls[0])['Accept-Profile'], 'atlas')
  assert.equal(headersOf(calls[1])['Accept-Profile'], undefined)
})

test('readRows throws the read-failed message for a non-OK response', async () => {
  const { fetch, calls } = collector(() => jsonResponse({ message: 'boom' }, 503))
  const rest = createSupabaseRest({
    supabaseUrl: 'https://project.supabase.co',
    serviceRoleKey: 'service-role-test-key',
    fetch,
  })

  await assert.rejects(
    rest.readRows('entities', new URLSearchParams()),
    (error: unknown) => error instanceof Error && error.message === 'Supabase read failed for entities: 503',
  )
  assert.equal(calls.length, 1)
})

test('readRows throws the invalid-response message for a non-array body', async () => {
  const { fetch, calls } = collector(() => jsonResponse({ rows: [] }))
  const rest = createSupabaseRest({
    supabaseUrl: 'https://project.supabase.co',
    serviceRoleKey: 'service-role-test-key',
    fetch,
  })

  await assert.rejects(
    rest.readRows('entities', new URLSearchParams()),
    (error: unknown) => error instanceof Error && error.message === 'Supabase returned an invalid entities response',
  )
  assert.equal(calls.length, 1)
})

test('readCount sends the exact-count preference and returns the Content-Range total', async () => {
  const { fetch, calls } = collector(() => jsonResponse([], 200, { 'Content-Range': '0-0/42' }))
  const rest = createSupabaseRest({
    supabaseUrl: 'https://project.supabase.co',
    serviceRoleKey: 'service-role-test-key',
    fetch,
  })

  const total = await rest.readCount('entity_items', new URLSearchParams({ select: 'id' }), 'atlas')

  assert.equal(total, 42)
  assert.equal(calls.length, 1)
  const headers = headersOf(calls[0])
  assert.equal(headers.Prefer, 'count=exact')
  assert.equal(headers.Range, '0-0')
  assert.equal(headers['Accept-Profile'], 'atlas')
})

test('readCount throws the read-failed message for a non-OK response', async () => {
  const { fetch, calls } = collector(() => jsonResponse({ message: 'boom' }, 500))
  const rest = createSupabaseRest({
    supabaseUrl: 'https://project.supabase.co',
    serviceRoleKey: 'service-role-test-key',
    fetch,
  })

  await assert.rejects(
    rest.readCount('entity_items', new URLSearchParams()),
    (error: unknown) => error instanceof Error && error.message === 'Supabase read failed for entity_items: 500',
  )
  assert.equal(calls.length, 1)
})

test('readCount throws when the Content-Range total is missing', async () => {
  const { fetch, calls } = collector(() => jsonResponse([]))
  const rest = createSupabaseRest({
    supabaseUrl: 'https://project.supabase.co',
    serviceRoleKey: 'service-role-test-key',
    fetch,
  })

  await assert.rejects(
    rest.readCount('entity_items', new URLSearchParams()),
    (error: unknown) => error instanceof Error && error.message === 'Supabase returned an invalid entity_items count',
  )
  assert.equal(calls.length, 1)
})
