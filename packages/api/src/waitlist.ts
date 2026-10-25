import { Hono } from 'hono'
import type { Context } from 'hono'
import { getConnInfo } from '@hono/node-server/conninfo'

// Table shape (public.waitlist: id uuid, email text, x_handle text, source
// text, created_at timestamptz, unique index on lower(email)) is owned by a
// separate DB migration; this endpoint only writes through PostgREST.

const REQUEST_TIMEOUT_MS = 10_000
const EMAIL_MAX_LENGTH = 254
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const X_HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/
const SOURCE_MAX_LENGTH = 64
const DEFAULT_RATE_LIMIT_MAX = 5
const DEFAULT_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000

export interface WaitlistRateLimit {
  max: number
  windowMs: number
}

export interface WaitlistRoutesConfig {
  supabaseUrl: string
  serviceRoleKey: string
  /** Injectable for tests; defaults to globalThis.fetch. */
  fetch?: typeof globalThis.fetch
  rateLimit?: Partial<WaitlistRateLimit>
}

function clientIp(c: Context): string {
  // nginx is the only entry point (the API itself listens on 127.0.0.1:3000)
  // and overwrites X-Real-IP with the real client address, so that header is
  // the one trusted identity for the per-IP rate limit. X-Forwarded-For and
  // cf-connecting-ip are deliberately ignored: nothing here strips them, so a
  // client could forge a fresh value per request to mint new limit buckets.
  const realIp = c.req.header('x-real-ip')
  if (realIp?.trim()) return realIp.trim().slice(0, 80)
  // Without the header, fall back to the socket's remote address. Hono's
  // in-memory Request adapter (app.request in tests) has no socket, hence the
  // catch; everything socket-less shares the 'anonymous' bucket.
  try {
    return getConnInfo(c).remote.address?.trim().slice(0, 80) || 'anonymous'
  } catch {
    return 'anonymous'
  }
}

/**
 * Public waitlist signup. Unauthenticated by design; abuse is bounded by the
 * per-IP sliding window below. Email is lowercased before insert, and the
 * table's unique index on lower(email) cannot be targeted by PostgREST
 * on_conflict, so the resulting duplicate-key 409 is treated as success.
 */
export function createWaitlistRoutes(config: WaitlistRoutesConfig): Hono {
  const app = new Hono()
  const fetchImpl = config.fetch ?? globalThis.fetch
  const insertUrl = `${config.supabaseUrl.replace(/\/$/, '')}/rest/v1/waitlist`
  const limits: WaitlistRateLimit = {
    max: config.rateLimit?.max ?? DEFAULT_RATE_LIMIT_MAX,
    windowMs: config.rateLimit?.windowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS,
  }
  // In-memory sliding window per IP, same shape as the swap rate budgets.
  const ipWindows = new Map<string, number[]>()
  let checks = 0

  function allow(ip: string): boolean {
    const now = Date.now()
    checks += 1
    if (checks % 256 === 0 || ipWindows.size > 5_000) {
      for (const [key, timestamps] of ipWindows) {
        const live = timestamps.filter((at) => now - at < limits.windowMs)
        if (live.length === 0) ipWindows.delete(key)
        else ipWindows.set(key, live)
      }
    }
    const recent = (ipWindows.get(ip) ?? []).filter((at) => now - at < limits.windowMs)
    if (recent.length >= limits.max) {
      ipWindows.set(ip, recent)
      return false
    }
    ipWindows.set(ip, [...recent, now])
    return true
  }

  function normalizeEmail(value: unknown): string | null {
    if (typeof value !== 'string') return null
    const email = value.trim().toLowerCase()
    if (email.length > EMAIL_MAX_LENGTH || !EMAIL_RE.test(email)) return null
    return email
  }

  function normalizeXHandle(value: unknown): { ok: true; handle: string | null } | { ok: false } {
    // Contract: absent or explicit null is "no handle"; a present non-string,
    // or a string that is empty/whitespace-only, is a bad handle ("@" alone
    // strips to nothing and fails the handle regex below).
    if (value === undefined || value === null) return { ok: true, handle: null }
    if (typeof value !== 'string') return { ok: false }
    const trimmed = value.trim()
    if (!trimmed) return { ok: false }
    const handle = trimmed.startsWith('@') ? trimmed.slice(1) : trimmed
    return X_HANDLE_RE.test(handle) ? { ok: true, handle } : { ok: false }
  }

  function normalizeSource(value: unknown): string | null {
    if (typeof value !== 'string') return null
    const source = value.trim()
    if (!source) return null
    return source.length > SOURCE_MAX_LENGTH ? source.slice(0, SOURCE_MAX_LENGTH) : source
  }

  app.post('/', async (c) => {
    // Check the limit before validation so repeated junk from one IP also
    // exhausts its budget.
    if (!allow(clientIp(c))) return c.json({ error: 'rate_limited' }, 429)

    let raw: unknown
    try {
      raw = await c.req.json()
    } catch {
      return c.json({ error: 'invalid_email' }, 400)
    }
    const body = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? raw as Record<string, unknown>
      : {}

    const email = normalizeEmail(body.email)
    if (!email) return c.json({ error: 'invalid_email' }, 400)
    const handle = normalizeXHandle(body.xHandle)
    if (!handle.ok) return c.json({ error: 'invalid_x_handle' }, 400)

    try {
      const response = await fetchImpl(insertUrl, {
        method: 'POST',
        headers: {
          apikey: config.serviceRoleKey,
          Authorization: `Bearer ${config.serviceRoleKey}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({ email, x_handle: handle.handle, source: normalizeSource(body.source) }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      // 201/204 from PostgREST, or the duplicate-key 409 (23505 under the
      // hood) for an already-lowercased address: either way the email is on
      // the list. Any other upstream outcome is a failure we log without the
      // request payload.
      if ((response.status >= 200 && response.status < 300) || response.status === 409) {
        return c.json({ ok: true }, 201)
      }
      console.error(`[waitlist] insert failed with upstream status ${response.status}`)
      return c.json({ error: 'waitlist_unavailable' }, 500)
    } catch (error) {
      console.error('[waitlist] insert request failed:', error instanceof Error ? error.message : error)
      return c.json({ error: 'waitlist_unavailable' }, 500)
    }
  })

  return app
}