import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'
import { createWaitlistRoutes, type WaitlistRoutesConfig } from './waitlist.js'

const SUPABASE_URL = 'https://stub.supabase.co'
const SERVICE_ROLE_KEY = 'stub-service-role-key'
const INSERT_URL = `${SUPABASE_URL}/rest/v1/waitlist`
const IP_A = '203.0.113.10'
const IP_B = '203.0.113.11'

interface RecordedRequest {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
  signal: unknown
}

function buildApp(config: Partial<WaitlistRoutesConfig> = {}) {
  const requests: RecordedRequest[] = []
  let nextResponse: () => Response = () => new Response(null, { status: 201 })
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      signal: init?.signal ?? null,
    })
    return nextResponse()
  }) as typeof fetch
  const app = new Hono()
  app.route('/waitlist', createWaitlistRoutes({
    supabaseUrl: SUPABASE_URL,
    serviceRoleKey: SERVICE_ROLE_KEY,
    fetch: fetchImpl,
    ...config,
  }))
  return {
    requests,
    setNextResponse: (make: () => Response) => { nextResponse = make },
    post(body: unknown, ip = IP_A): Promise<Response> {
      return Promise.resolve(app.request('/waitlist', {
        method: 'POST',
        body: typeof body === 'string' ? body : JSON.stringify(body),
        headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      }))
    },
  }
}

test('valid signup inserts via PostgREST and answers 201 with no secret in the response', async () => {
  const h = buildApp()
  const response = await h.post({ email: 'Foo@Bar.COM', xHandle: '@good_one', source: 'x'.repeat(100) })

  assert.equal(response.status, 201)
  const text = await response.text()
  assert.deepEqual(JSON.parse(text), { ok: true })
  assert.ok(!text.includes(SERVICE_ROLE_KEY))

  assert.equal(h.requests.length, 1)
  const sent = h.requests[0]
  assert.equal(sent.url, INSERT_URL)
  assert.equal(sent.headers.apikey, SERVICE_ROLE_KEY)
  assert.equal(sent.headers.Authorization, `Bearer ${SERVICE_ROLE_KEY}`)
  assert.equal(sent.headers['Content-Type'], 'application/json')
  assert.equal(sent.headers.Prefer, 'return=minimal')
  assert.ok(sent.signal instanceof AbortSignal)
  assert.deepEqual(sent.body, { email: 'foo@bar.com', x_handle: 'good_one', source: 'x'.repeat(64) })
})

test('email is trimmed and lowercased before insert', async () => {
  const h = buildApp()
  await h.post({ email: '  Upper.Case@Example.COM ' })
  assert.equal(h.requests[0].body.email, 'upper.case@example.com')
})

test('repeat email (upstream 409 unique violation) still answers 201', async () => {
  const h = buildApp()
  h.setNextResponse(() => Response.json({ code: '23505', message: 'duplicate key value' }, { status: 409 }))
  const response = await h.post({ email: 'again@example.com' })
  assert.equal(response.status, 201)
  assert.deepEqual(await response.json(), { ok: true })
})

test('invalid or malformed email answers 400 invalid_email without touching upstream', async () => {
  const h = buildApp({ rateLimit: { max: 100 } })
  const bad: unknown[] = [
    {},
    { email: 123 },
    { email: 'not-an-email' },
    { email: 'a@b' },
    { email: 'a b@c.com' },
    { email: `x${'y'.repeat(254)}@c.com` },
    { email: null },
    '{not json',
  ]
  for (const body of bad) {
    const response = await h.post(body)
    assert.equal(response.status, 400, `expected 400 for ${JSON.stringify(body)}`)
    assert.deepEqual(await response.json(), { error: 'invalid_email' })
  }
  assert.equal(h.requests.length, 0)
})

test('xHandle keeps one stripped @, rejects oversized, hyphenated and non-string values', async () => {
  const h = buildApp()
  await h.post({ email: 'a@example.com', xHandle: 'good_one' })
  assert.equal(h.requests[0].body.x_handle, 'good_one')

  for (const xHandle of ['a'.repeat(16), 'bad-handle', 7]) {
    const response = await h.post({ email: 'a@example.com', xHandle })
    assert.equal(response.status, 400, `expected 400 for xHandle ${JSON.stringify(xHandle)}`)
    assert.deepEqual(await response.json(), { error: 'invalid_x_handle' })
  }
  assert.equal(h.requests.length, 1)

  const empty = buildApp()
  await empty.post({ email: 'a@example.com', xHandle: '   ' })
  assert.equal(empty.requests[0].body.x_handle, null)
  await empty.post({ email: 'b@example.com' })
  assert.equal(empty.requests[1].body.x_handle, null)
})

test('source is trimmed, truncated to 64 chars, and null for empty or non-string', async () => {
  const h = buildApp()
  await h.post({ email: 'a@example.com', source: '  ' })
  assert.equal(h.requests[0].body.source, null)

  await h.post({ email: 'b@example.com', source: 's'.repeat(100) })
  assert.equal(h.requests[1].body.source, 's'.repeat(64))

  await h.post({ email: 'c@example.com', source: 42 })
  assert.equal(h.requests[2].body.source, null)
})

test('a 6th request from one IP is rate limited while another IP still signs up', async () => {
  const h = buildApp()
  for (let i = 0; i < 5; i += 1) {
    const response = await h.post({ email: `rate${i}@example.com` })
    assert.equal(response.status, 201)
  }
  const limited = await h.post({ email: 'rate5@example.com' })
  assert.equal(limited.status, 429)
  assert.deepEqual(await limited.json(), { error: 'rate_limited' })
  assert.equal(h.requests.length, 5, 'rate-limited request must not reach upstream')

  const otherIp = await h.post({ email: 'other@example.com' }, IP_B)
  assert.equal(otherIp.status, 201)
  assert.equal(h.requests.length, 6)
})

test('the limit is checked before validation, so junk requests burn budget', async () => {
  const h = buildApp({ rateLimit: { max: 2 } })
  for (let i = 0; i < 2; i += 1) {
    const response = await h.post({ email: 'nope' })
    assert.equal(response.status, 400)
  }
  const valid = await h.post({ email: 'valid@example.com' })
  assert.equal(valid.status, 429)
  assert.deepEqual(await valid.json(), { error: 'rate_limited' })
})

test('upstream 500 answers 500 waitlist_unavailable', async () => {
  const h = buildApp()
  h.setNextResponse(() => new Response('boom', { status: 500 }))
  const response = await h.post({ email: 'a@example.com' })
  assert.equal(response.status, 500)
  assert.deepEqual(await response.json(), { error: 'waitlist_unavailable' })
})

test('upstream network failure answers 500 waitlist_unavailable', async () => {
  const fetchImpl = (async () => {
    throw new Error('connection refused')
  }) as typeof fetch
  const app = new Hono()
  app.route('/waitlist', createWaitlistRoutes({
    supabaseUrl: SUPABASE_URL,
    serviceRoleKey: SERVICE_ROLE_KEY,
    fetch: fetchImpl,
  }))
  const response = await app.request('/waitlist', {
    method: 'POST',
    body: JSON.stringify({ email: 'a@example.com' }),
    headers: { 'content-type': 'application/json' },
  })
  assert.equal(response.status, 500)
  assert.deepEqual(await response.json(), { error: 'waitlist_unavailable' })
})