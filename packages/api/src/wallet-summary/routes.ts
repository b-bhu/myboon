/**
 * GET /wallet/summary (#725): one server call that returns every app's
 * summary, so the phone stops fetching from five places. Shape:
 * `?solana=<address>&evm=<address>` — both optional, at least one
 * required. The Solana regex is copied from src/spot/routes.ts so both routes
 * accept exactly the same addresses; EVM is `0x` + 40 hex characters.
 *
 * Guard (#743): per-IP rate limit copied from `createRpcRateLimiter`
 * (src/rpc/routes.ts) — 240 requests per 60 seconds per IP. Behind the
 * proxy, the forwarding headers are trusted only when TRUST_PROXY_HEADERS
 * is set, exactly as /rpc does.
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import { getConnInfo } from '@hono/node-server/conninfo'
import type { WalletSummaryService } from './service.js'

// Same base58 pattern as /spot/:wallet/balances (src/spot/routes.ts).
const SOLANA_ADDRESS_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
// EVM: 0x plus 40 hex characters.
const EVM_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/

export type WalletRateLimiter = {
  consume: (identity: string, cost: number) => { ok: boolean; retryAfterSeconds: number }
}

// Copied from createRpcRateLimiter (src/rpc/routes.ts:38) as #743 directs:
// one fixed-window bucket per identity, swept back down past 10 000
// entries.
export function createWalletRateLimiter(limit = 240, windowMs = 60_000): WalletRateLimiter {
  const buckets = new Map<string, { startedAt: number; used: number }>()
  return {
    consume(identity, cost) {
      const now = Date.now()
      const current = buckets.get(identity)
      const bucket = !current || now - current.startedAt >= windowMs
        ? { startedAt: now, used: 0 }
        : current
      if (bucket.used + cost > limit) {
        buckets.set(identity, bucket)
        return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((windowMs - (now - bucket.startedAt)) / 1000)) }
      }
      bucket.used += cost
      buckets.set(identity, bucket)
      if (buckets.size > 10_000) {
        for (const [key, item] of buckets) if (now - item.startedAt >= windowMs) buckets.delete(key)
      }
      return { ok: true, retryAfterSeconds: 0 }
    },
  }
}

// Copied with the limiter: the address is the quota identity. A
// caller-controlled session header is deliberately not part of the key:
// otherwise a client could mint session values to obtain unlimited
// per-IP quota. These forwarding headers are only trusted when the
// deployment's proxy strips/replaces them.
function identityFromHeaders(request: Request, trustForwardedHeaders: boolean): string {
  if (!trustForwardedHeaders) return 'unknown'
  return request.headers.get('cf-connecting-ip')
    ?? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    ?? 'unknown'
}

function identityFromContext(context: Context, trustForwardedHeaders: boolean): string {
  if (trustForwardedHeaders) return identityFromHeaders(context.req.raw, true)
  try {
    return getConnInfo(context).remote.address ?? 'unknown'
  } catch {
    // Hono's in-memory Request adapter has no socket context. Production
    // Node requests use getConnInfo; tests and other adapters share unknown.
    return 'unknown'
  }
}

export function createWalletSummaryRoutes(options: {
  service: WalletSummaryService
  rateLimiter?: WalletRateLimiter
  trustForwardedHeaders?: boolean
}): Hono {
  const routes = new Hono()
  const { service } = options
  const limiter = options.rateLimiter ?? createWalletRateLimiter()
  const identityFor = (c: Context) => identityFromContext(c, options.trustForwardedHeaders === true)

  routes.get('/summary', async (c) => {
    const solana = c.req.query('solana') || null
    const evm = c.req.query('evm') || null
    if (!solana && !evm) {
      return c.json({ error: 'At least one of solana or evm is required', code: 'MISSING_ADDRESS' }, 400)
    }
    if (solana && !SOLANA_ADDRESS_PATTERN.test(solana)) {
      return c.json({ error: 'Invalid solana address', code: 'INVALID_ADDRESS' }, 400)
    }
    if (evm && !EVM_ADDRESS_PATTERN.test(evm)) {
      return c.json({ error: 'Invalid evm address', code: 'INVALID_ADDRESS' }, 400)
    }
    const quota = limiter.consume(identityFor(c), 1)
    if (!quota.ok) {
      return c.json(
        { error: 'Wallet summary rate limit exceeded', code: 'RATE_LIMITED' },
        429,
        { 'Retry-After': String(quota.retryAfterSeconds) },
      )
    }
    return c.json(await service.getSummary({ solana, evm }))
  })

  return routes
}
