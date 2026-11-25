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
import type { MeteoraPositionsResponse, PerpPositionsResponse, PhoenixOrdersResponse } from '@myboon/shared/wallet-summary'
import { createPhoenixConfig, createPhoenixUpstream, type PhoenixUpstream } from '../phoenix/index.js'
import type { WalletSummaryService } from './service.js'
import { fetchMeteoraPositions } from './venues/meteora.js'
import { fetchPacificaPositions } from './venues/pacifica.js'
import { createPhoenixPositionsReader } from './venues/phoenix.js'
import { createPhoenixOrdersReader } from './venues/phoenix-orders.js'

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
  /** Reads every Meteora position (#867); production uses the venue's reader. */
  meteoraPositions?: (solana: string | null) => Promise<MeteoraPositionsResponse>
  /** Reads every open Phoenix position (#899); production passes the reader on the shared Phoenix upstream. */
  phoenixPositions?: (solana: string | null) => Promise<PerpPositionsResponse>
  /** Lists every active Phoenix take-profit and stop-loss order (#900); production passes the reader on the shared Phoenix upstream. */
  phoenixOrders?: (solana: string | null) => Promise<PhoenixOrdersResponse>
  /** Reads every open Pacifica position (#868); production uses the venue's reader. */
  pacificaPositions?: (solana: string | null) => Promise<PerpPositionsResponse>
  rateLimiter?: WalletRateLimiter
  trustForwardedHeaders?: boolean
}): Hono {
  const routes = new Hono()
  const { service } = options
  const limiter = options.rateLimiter ?? createWalletRateLimiter()
  const meteoraPositions = options.meteoraPositions ?? fetchMeteoraPositions
  // No reader passed: one default upstream, as venues/index.ts builds for the summary.
  let defaultPhoenixUpstream: PhoenixUpstream | null = null
  const phoenixUpstream = () => (defaultPhoenixUpstream ??= createPhoenixUpstream(createPhoenixConfig()))
  const phoenixPositions = options.phoenixPositions ?? createPhoenixPositionsReader(phoenixUpstream())
  const phoenixOrders = options.phoenixOrders ?? createPhoenixOrdersReader(phoenixUpstream())
  const pacificaPositions = options.pacificaPositions ?? fetchPacificaPositions
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

  // GET /wallet/meteora/positions?solana= (#867): read-only, same address
  // check and per-IP limiter as the summary. No address = no Meteora
  // account: `not_connected`, as the summary's Meteora slot answers.
  routes.get('/meteora/positions', async (c) => {
    const solana = c.req.query('solana') || null
    if (solana && !SOLANA_ADDRESS_PATTERN.test(solana)) {
      return c.json({ error: 'Invalid solana address', code: 'INVALID_ADDRESS' }, 400)
    }
    const quota = limiter.consume(identityFor(c), 1)
    if (!quota.ok) {
      return c.json(
        { error: 'Wallet summary rate limit exceeded', code: 'RATE_LIMITED' },
        429,
        { 'Retry-After': String(quota.retryAfterSeconds) },
      )
    }
    return c.json(await meteoraPositions(solana))
  })

  // GET /wallet/phoenix/positions?solana= (#899): read-only, same address
  // check and per-IP limiter as the Meteora route. No address = no Phoenix
  // account: `not_connected`.
  routes.get('/phoenix/positions', async (c) => {
    const solana = c.req.query('solana') || null
    if (solana && !SOLANA_ADDRESS_PATTERN.test(solana)) {
      return c.json({ error: 'Invalid solana address', code: 'INVALID_ADDRESS' }, 400)
    }
    const quota = limiter.consume(identityFor(c), 1)
    if (!quota.ok) {
      return c.json(
        { error: 'Wallet summary rate limit exceeded', code: 'RATE_LIMITED' },
        429,
        { 'Retry-After': String(quota.retryAfterSeconds) },
      )
    }
    return c.json(await phoenixPositions(solana))
  })

  // GET /wallet/phoenix/orders?solana= (#900): read-only, same address check
  // and per-IP limiter as the positions route.
  routes.get('/phoenix/orders', async (c) => {
    const solana = c.req.query('solana') || null
    if (solana && !SOLANA_ADDRESS_PATTERN.test(solana)) {
      return c.json({ error: 'Invalid solana address', code: 'INVALID_ADDRESS' }, 400)
    }
    const quota = limiter.consume(identityFor(c), 1)
    if (!quota.ok) {
      return c.json(
        { error: 'Wallet summary rate limit exceeded', code: 'RATE_LIMITED' },
        429,
        { 'Retry-After': String(quota.retryAfterSeconds) },
      )
    }
    return c.json(await phoenixOrders(solana))
  })

  // GET /wallet/pacifica/positions?solana= (#868): read-only, same address
  // check and per-IP limiter as the other wallet routes.
  routes.get('/pacifica/positions', async (c) => {
    const solana = c.req.query('solana') || null
    if (solana && !SOLANA_ADDRESS_PATTERN.test(solana)) {
      return c.json({ error: 'Invalid solana address', code: 'INVALID_ADDRESS' }, 400)
    }
    const quota = limiter.consume(identityFor(c), 1)
    if (!quota.ok) {
      return c.json(
        { error: 'Wallet summary rate limit exceeded', code: 'RATE_LIMITED' },
        429,
        { 'Retry-After': String(quota.retryAfterSeconds) },
      )
    }
    return c.json(await pacificaPositions(solana))
  })

  return routes
}
