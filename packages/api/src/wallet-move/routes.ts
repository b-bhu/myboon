/**
 * POST /wallet/move/quote (#746): the app asks this API for a Move quote and
 * this API asks Relay, carrying the key (Decision Log D55: the key never
 * ships in the app). Nothing signs or submits on the server — the quote only
 * carries Relay's signing steps, passed through untouched, for the app to
 * review and sign.
 *
 * Request body `{ source: { chainId, currency }, destination: { chainId,
 * currency }, amount, userAddress }`; the mapped answer is the shared
 * `WalletMoveQuoteResult` from `@myboon/shared/wallet-move`. Launch scope is
 * Solana (792703809) and Base (8453): chains outside it come back as
 * `route_not_supported` with a plain reason, not an error. Bad input is
 * 400 `{ error, code }`. A Relay error, an unusable upstream answer or a
 * timeout is 502 with a short message of our words and nothing from Relay's
 * body. A missing RELAY_API_KEY is 503.
 *
 * The key is never logged and never returned: it is written to exactly one
 * place, the upstream `x-api-key` request header, and no upstream body or
 * message is ever echoed or logged.
 *
 * Per-IP rate limit copied from `createRpcRateLimiter` (src/rpc/routes.ts:38)
 * as #743 did for /wallet/summary, with the same forwarding-header rule.
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import { getConnInfo } from '@hono/node-server/conninfo'
import type {
  WalletMoveQuote,
  WalletMoveQuoteFees,
  WalletMoveQuoteLeg,
  WalletMoveQuoteResult,
} from '@myboon/shared/wallet-move'

const RELAY_QUOTE_URL = 'https://api.relay.link/quote/v2'
// Launch scope (#746, wiki Move findings): Move launches on Solana and Base.
const SOLANA_CHAIN_ID = 792703809
const LAUNCH_CHAIN_IDS = new Set([SOLANA_CHAIN_ID, 8453])
const DEFAULT_TIMEOUT_MS = 12_000

// Same base58 and EVM patterns as /wallet/summary (src/wallet-summary/routes.ts),
// applied to the user's address on the chain it deposits from.
const SOLANA_ADDRESS_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const EVM_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/

export type WalletMoveRateLimiter = {
  consume: (identity: string, cost: number) => { ok: boolean; retryAfterSeconds: number }
}

export type WalletMoveFetch = (input: string | URL, init?: RequestInit) => Promise<Response>

// Copied from createRpcRateLimiter (src/rpc/routes.ts:38): one fixed-window
// bucket per identity, swept back down past 10 000 entries.
export function createWalletMoveRateLimiter(limit = 240, windowMs = 60_000): WalletMoveRateLimiter {
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

// Copied from src/wallet-summary/routes.ts and src/rpc/routes.ts: the address
// is the quota identity; forwarding headers are trusted only when the
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
    return 'unknown'
  }
}

function abortAfter(timeoutMs: number): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  return { signal: controller.signal, cancel: () => clearTimeout(timer) }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isDigitString = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9]+$/.test(value)

/** Positive in the full sense: digits, not zero. */
const positiveAmount = (value: unknown): value is string =>
  isDigitString(value) && value !== '0'.repeat(value.length)

/** One validated side of the move: a Relay chain id and a currency ref. */
export type QuoteRequestLeg = { chainId: number; currency: string }

export type ParsedQuoteRequest = {
  source: QuoteRequestLeg
  destination: QuoteRequestLeg
  /** Positive base-unit amount, decimal string. */
  amount: string
  /** The user's address on the source chain. */
  userAddress: string
}

/**
 * Validates the route's request body. Returns the failure as
 * `{ error, code }` for the 400 answer, or the normalized request.
 */
export function parseQuoteRequest(body: unknown):
  | { ok: true; request: ParsedQuoteRequest }
  | { ok: false; error: string; code: string } {
  if (!isRecord(body)) return { ok: false, error: 'The quote request must be a JSON object.', code: 'INVALID_BODY' }
  const source = body.source
  const destination = body.destination
  if (!isRecord(source) || !isRecord(destination)) {
    return { ok: false, error: 'The quote request needs a source and a destination.', code: 'INVALID_BODY' }
  }
  if (typeof source.chainId !== 'number' || !Number.isInteger(source.chainId)
    || typeof destination.chainId !== 'number' || !Number.isInteger(destination.chainId)) {
    return { ok: false, error: 'The source and destination chain ids must be numbers.', code: 'INVALID_CHAIN' }
  }
  if (typeof source.currency !== 'string' || source.currency.trim() === ''
    || typeof destination.currency !== 'string' || destination.currency.trim() === '') {
    return { ok: false, error: 'The source and destination need a currency the app quotes with.', code: 'INVALID_CURRENCY' }
  }
  if (!positiveAmount(body.amount)) {
    return { ok: false, error: 'The amount must be a positive base-unit decimal string.', code: 'INVALID_AMOUNT' }
  }
  const userAddress = body.userAddress
  if (typeof userAddress !== 'string') {
    return { ok: false, error: 'The user address is required.', code: 'INVALID_ADDRESS' }
  }
  // The address fits the chain it deposits from. Chains outside the launch
  // scope have no format rule here; the scope check answers them below.
  if (source.chainId === SOLANA_CHAIN_ID && !SOLANA_ADDRESS_PATTERN.test(userAddress)) {
    return { ok: false, error: 'The user address is not a valid Solana address.', code: 'INVALID_ADDRESS' }
  }
  if (source.chainId !== SOLANA_CHAIN_ID && LAUNCH_CHAIN_IDS.has(source.chainId)
    && !EVM_ADDRESS_PATTERN.test(userAddress)) {
    return { ok: false, error: 'The user address is not a valid EVM address.', code: 'INVALID_ADDRESS' }
  }
  return {
    ok: true,
    request: {
      source: { chainId: source.chainId, currency: source.currency },
      destination: { chainId: destination.chainId, currency: destination.currency },
      amount: body.amount,
      userAddress,
    },
  }
}

/** Launch-scope check: Move launches between Solana and Base only (#746). */
export function routeNotSupported(request: ParsedQuoteRequest): WalletMoveQuoteResult | null {
  if (LAUNCH_CHAIN_IDS.has(request.source.chainId) && LAUNCH_CHAIN_IDS.has(request.destination.chainId)) return null
  return {
    result: 'route_not_supported',
    sourceChainId: request.source.chainId,
    destinationChainId: request.destination.chainId,
    reason: 'Move launches on Solana and Base for now. Pick one of those chains to start the move.',
  }
}

/** One fee line Relay reports: a resolved currency plus its amounts. */
type RelayFeeLine = {
  currency?: { chainId?: unknown; address?: unknown; symbol?: unknown; id?: unknown }
  amount?: unknown
  amountUsd?: unknown
}

function legFrom(feeLine: RelayFeeLine | undefined, fallbackChainId: number): WalletMoveQuoteLeg | null {
  const currency = feeLine?.currency
  if (typeof currency?.chainId !== 'number' || typeof feeLine?.amount !== 'string' || feeLine.amount === ''
    || typeof feeLine.amountUsd !== 'string' || feeLine.amountUsd === '') return null
  const ref = currency.address ?? currency.symbol ?? currency.id
  if (typeof ref !== 'string' || ref === '') return null
  return { chainId: currency.chainId as number, currency: ref, amount: feeLine.amount, amountUsd: feeLine.amountUsd }
}

function usdAmountUs(impact: unknown): string | null {
  if (!isRecord(impact) || typeof impact.usd !== 'string' || impact.usd === '' || !Number.isFinite(Number(impact.usd))) {
    return null
  }
  return impact.usd
}

/**
 * Maps Relay's `POST /quote/v2` answer onto the shared
 * `WalletMoveQuoteResult`. Returns null when the answer cannot be used, so
 * the route answers 502 with nothing from Relay's body instead of a half-
 * built quote.
 */
export function mapRelayQuote(payload: unknown): WalletMoveQuoteResult | null {
  if (!isRecord(payload)) return null
  const { requestId, steps, fees, details } = payload as {
    requestId?: unknown
    steps?: unknown
    fees?: { relayer?: RelayFeeLine; gas?: RelayFeeLine }
    details?: Record<string, unknown>
  } & Record<string, unknown>
  if (typeof requestId !== 'string' || requestId === '') return null
  // The signing steps ride through untouched — the app shows the steps it
  // must sign. Relay defines each step as one item, a signature or a
  // transaction; a quote without steps cannot be acted on.
  if (!Array.isArray(steps) || steps.length === 0) return null
  const source = legFrom(details?.currencyIn as RelayFeeLine | undefined, 0)
  const destination = legFrom(details?.currencyOut as RelayFeeLine | undefined, 0)
  if (!source || !destination) return null
  const executionUsd = typeof fees?.relayer?.amountUsd === 'string' && fees.relayer.amountUsd !== ''
    ? fees.relayer.amountUsd
    : null
  if (executionUsd === null) return null
  const expandedPriceImpact = details?.expandedPriceImpact as Record<string, unknown> | undefined
  const swapUsd = usdAmountUs(expandedPriceImpact?.swap)
  if (swapUsd === null) return null
  const timeEstimate = details?.timeEstimate
  if (typeof timeEstimate !== 'number' || !Number.isFinite(timeEstimate)) return null
  const quoteFees: WalletMoveQuoteFees = { executionUsd, swapUsd }
  // The app fee, when Relay priced one (it is charged in the input token),
  // and the origin gas as the raw amount in the source chain's native token.
  const appUsd = usdAmountUs(expandedPriceImpact?.app)
  if (appUsd !== null && Number(appUsd) !== 0) quoteFees.appUsd = appUsd
  if (typeof fees?.gas?.amount === 'string' && fees.gas.amount !== '') quoteFees.gas = fees.gas.amount
  const quote: WalletMoveQuote = {
    requestId,
    source,
    destination,
    fees: quoteFees,
    timeEstimateSeconds: timeEstimate,
    step: steps,
  }
  return { result: 'quoted', quote }
}

export function createWalletMoveRoutes(options: {
  relayApiKey?: string
  fetchImpl?: WalletMoveFetch
  rateLimiter?: WalletMoveRateLimiter
  trustForwardedHeaders?: boolean
  timeoutMs?: number
}): Hono {
  const routes = new Hono()
  const limiter = options.rateLimiter ?? createWalletMoveRateLimiter()
  const identityFor = (c: Context) => identityFromContext(c, options.trustForwardedHeaders === true)
  const notConfigured: WalletMoveRoutesError = {
    error: 'Move quotes are not available: the server is not configured.',
    code: 'NOT_CONFIGURED',
  }

  routes.post('/move/quote', async (c) => {
    // The key's absence is degraded mode (#782), not an error of the request.
    if (!options.relayApiKey) return c.json(notConfigured, 503)

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'The quote request body must be JSON.', code: 'INVALID_BODY' }, 400)
    }
    const parsed = parseQuoteRequest(body)
    if (!parsed.ok) return c.json({ error: parsed.error, code: parsed.code }, 400)
    const { request } = parsed

    const unsupported = routeNotSupported(request)
    if (unsupported) return c.json(unsupported)

    const quota = limiter.consume(identityFor(c), 1)
    if (!quota.ok) {
      return c.json(
        { error: 'Move quote rate limit exceeded. Try again shortly.', code: 'RATE_LIMITED' },
        429,
        { 'Retry-After': String(quota.retryAfterSeconds) },
      )
    }

    const upstreamBody = {
      user: request.userAddress,
      originChainId: request.source.chainId,
      originCurrency: request.source.currency,
      destinationChainId: request.destination.chainId,
      destinationCurrency: request.destination.currency,
      amount: request.amount,
      tradeType: 'EXACT_INPUT',
    }
    const timeout = abortAfter(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    try {
      const upstream = await (options.fetchImpl ?? fetch)(RELAY_QUOTE_URL, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          // The key lives in exactly this header and nowhere else (D55).
          'x-api-key': options.relayApiKey,
        },
        body: JSON.stringify(upstreamBody),
        signal: timeout.signal,
      })
      if (!upstream.ok) {
        return c.json(
          { error: 'Relay could not price this move right now. Try again shortly.', code: 'UPSTREAM_FAILED' },
          502,
        )
      }
      let quotePayload: unknown
      try {
        quotePayload = JSON.parse(await upstream.text())
      } catch {
        quotePayload = null
      }
      const result = quotePayload === null ? null : mapRelayQuote(quotePayload)
      if (result === null) {
        return c.json(
          { error: 'Relay returned a quote this API cannot use. Try again shortly.', code: 'UPSTREAM_INVALID' },
          502,
        )
      }
      return c.json(result)
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'AbortError'
      return c.json({
        error: timedOut ? 'Relay took too long to price this move.' : 'Relay could not be reached.',
        code: timedOut ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNAVAILABLE',
      }, 502)
    } finally {
      timeout.cancel()
    }
  })

  return routes
}

type WalletMoveRoutesError = { error: string; code: string }
