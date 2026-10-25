import { Hono } from 'hono'

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

function clientIp(c: { req: { header(name: string): string | undefined } }): string {
  const direct = c.req.header('cf-connecting-ip') ?? c.req.header('x-real-ip')
  if (direct?.trim()) return direct.trim().slice(0, 80)
  return c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'anonymous'
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
    if (value === undefined) return { ok: true, handle: null }
    // Contract: any present non-string (including null) is a bad handle.
    if (typeof value !== 'string') return { ok: false }
    const trimmed = value.trim()
    if (!trimmed) return { ok: true, handle: null }
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