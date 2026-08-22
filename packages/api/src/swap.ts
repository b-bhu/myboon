import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { assertSolanaAddress } from '@myboon/shared/spot'
import type { TokenIdentity } from './tokens/types.js'
import { resolveRef, warmMintIdentities } from './tokens/identity-service.js'
import {
  createMemorySwapExecutionStore,
  type SwapExecutionRecord,
  type SwapExecutionStore,
} from './swap/store.js'

const DEFAULT_JUP_API_BASE = 'https://api.jup.ag'
const REQUEST_TIMEOUT_MS = 10_000
const QUOTE_CACHE_MS = 2_000
const MAX_UINT64 = 18_446_744_073_709_551_615n
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

export type SwapRateBudget = 'discovery' | 'quote' | 'signable' | 'execute'

export interface SwapRateLimits {
  discovery: number
  quote: number
  signable: number
  execute: number
  windowMs: number
}

export interface SwapIdentityService {
  resolveRef(ref: string): TokenIdentity
  warmMintIdentities?(mints: readonly string[]): Promise<void>
}

export interface CreateSwapRoutesConfig {
  /** Server-held Jupiter credential. It is never read from an Expo env var. */
  jupApiKey?: string
  /** Injected in tests and deployment; no provider URL is accepted from a request. */
  jupApiBase?: string
  fetchImpl?: typeof fetch
  identity?: SwapIdentityService
  store?: SwapExecutionStore
  priorityFeeMaxLamports?: bigint | string | number
  tradingEnabled?: boolean
  rateLimits?: Partial<SwapRateLimits>
  /** Redacted operational events only; never receives wallet addresses or transaction bytes. */
  observe?: (event: SwapOperationalEvent) => void
}

export interface SwapOperationalEvent {
  event: 'discovery' | 'order' | 'execute'
  at: string
  requestId: string
  ok: boolean
  durationMs: number
  code?: string
  outcome?: SwapExecuteResponse['outcome']
  itemCount?: number
  partial?: boolean
  orderKind?: 'quote' | 'signable'
}

export interface SwapApiErrorResponse {
  error: {
    code: string
    message: string
    retryable: boolean
    requestId: string | null
  }
}

export interface SpotTokenSummary {
  identity: TokenIdentity
  usdPrice: number | null
  momentumPct: { m5: number | null; h1: number | null; h6: number | null; h24: number | null }
  market: { marketCapUsd: number | null; liquidityUsd: number | null; volume24hUsd: number | null }
  warnings: { verification: 'verified' | 'unverified' | 'unknown'; organicActivity: 'high' | 'medium' | 'low' | 'unknown'; suspicious: true | null }
  updatedAt: string | null
}

export interface SpotTokenListResponse {
  items: SpotTokenSummary[]
  ranking: 'toptrending_1h'
  asOf: string
  partial: boolean
}

export interface SpotTokenSearchResponse {
  query: string
  items: SpotTokenSummary[]
  asOf: string
  partial: boolean
}

export interface SpotPriceResponse {
  prices: Array<{ mint: string; usdPrice: number | null; blockId: number | null }>
  asOf: string
}

export interface SwapOrderRequest {
  inputMint: string
  outputMint: string
  amountAtomic: string
  taker?: string
  slippageBps?: number
}

export interface SwapOrderBase {
  requestId: string
  inputMint: string
  outputMint: string
  inAmountAtomic: string
  outAmountAtomic: string
  minimumOutAmountAtomic: string
  inUsdValue: number | null
  outUsdValue: number | null
  priceImpactPct: number | null
  slippageBps: number
  router: 'metis' | 'jupiterz' | 'dflow' | 'okx' | 'unknown'
  route: Array<{ label: string; percent: number }>
  fees: {
    providerFeeBps: number | null
    providerFeeAtomic: string | null
    providerFeeMint: string | null
    signatureFeeLamports: string | null
    priorityFeeLamports: string | null
    rentFeeLamports: string | null
    myboonFeeAtomic: '0'
    gasless: boolean
  }
  expiresAt: string | null
}

export type SwapOrderResponse = SwapOrderBase & (
  | { kind: 'quote'; taker: null; transaction: null; lastValidBlockHeight: null }
  | { kind: 'signable'; taker: string; transaction: string; lastValidBlockHeight: string }
)

export interface SwapExecuteResponse {
  outcome: 'confirmed' | 'failed' | 'unknown'
  signature: string | null
  slot: string | null
  code: number | null
  message: string | null
  totalInputAmountAtomic: string | null
  totalOutputAmountAtomic: string | null
  inputAmountResultAtomic: string | null
  outputAmountResultAtomic: string | null
}

class SwapGatewayError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 409 | 422 | 429 | 502 | 503 | 202 = 502,
    readonly retryable = false,
  ) {
    super(message)
  }
}

interface CacheEntry<T> { value: T; expiresAt: number }

function nowIso(): string { return new Date().toISOString() }

function requestIdFrom(c: { req: { header(name: string): string | undefined } }): string {
  const supplied = c.req.header('x-request-id')?.trim()
  return supplied && supplied.length <= 120 && /^[A-Za-z0-9._:-]+$/.test(supplied) ? supplied : randomUUID()
}

function clientSession(c: { req: { header(name: string): string | undefined } }): string {
  const supplied = c.req.header('x-myboon-session') ?? c.req.header('x-client-session')
  if (supplied && supplied.length <= 160) return supplied
  return 'anonymous'
}

function clientIp(c: { req: { header(name: string): string | undefined } }): string {
  const direct = c.req.header('cf-connecting-ip') ?? c.req.header('x-real-ip')
  if (direct?.trim()) return direct.trim().slice(0, 80)
  return c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'anonymous'
}

function jsonRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function numberValue(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function integerString(value: unknown): string | null {
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value)
  if (typeof value === 'string' && /^[0-9]+$/.test(value)) return value
  return null
}

function publicKey(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    assertSolanaAddress(value, 'address')
    return true
  } catch {
    return false
  }
}

function isoStringOrNull(value: unknown): string | null {
  const text = stringValue(value)
  return text && Number.isFinite(Date.parse(text)) ? text : null
}

function nonnegativeSafeIntegerOrNull(value: unknown): number | null {
  const parsed = numberValue(value)
  return parsed !== null && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}

function positiveUint64(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value) || value.length > 20) return false
  try {
    const parsed = BigInt(value)
    return parsed > 0n && parsed <= MAX_UINT64
  } catch { return false }
}

function boundedUint64(value: unknown): string | null {
  if (!integerString(value)) return null
  try {
    const parsed = BigInt(integerString(value)!)
    return parsed <= MAX_UINT64 ? parsed.toString() : null
  } catch { return null }
}

function finiteOrNull(value: unknown): number | null {
  const parsed = numberValue(value)
  return parsed !== null && parsed >= 0 ? parsed : null
}

function signedFiniteOrNull(value: unknown): number | null {
  return numberValue(value)
}

function first(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined && value !== null)
}

function errorPayload(error: SwapGatewayError, requestId: string): SwapApiErrorResponse {
  return { error: { code: error.code, message: error.message, retryable: error.retryable, requestId } }
}

function errorResponse(c: { json(value: unknown, status?: number): Response }, error: SwapGatewayError, requestId: string): Response {
  return c.json(errorPayload(error, requestId), error.status)
}

async function readJson(c: { req: { json(): Promise<unknown> } }): Promise<Record<string, unknown>> {
  try {
    const body = jsonRecord(await c.req.json())
    if (!body) throw new Error('object')
    return body
  } catch {
    throw new SwapGatewayError('INVALID_JSON', 'Request body must be a JSON object.', 400)
  }
}

function assertOnlyFields(body: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key))
  if (unknown.length > 0) throw new SwapGatewayError('INVALID_FIELDS', `Unsupported request field: ${unknown[0]}.`, 400)
}

function normalizePriorityFee(value: bigint | string | number | undefined): bigint {
  if (typeof value === 'bigint' && value >= 0n && value <= MAX_UINT64) return value
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value)
  if (typeof value === 'string' && /^[0-9]+$/.test(value)) {
    const parsed = BigInt(value)
    if (parsed <= MAX_UINT64) return parsed
  }
  return 1_000_000n
}

async function fetchWithTimeout(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}

async function parseProviderBody(response: Response): Promise<Record<string, unknown> | unknown[]> {
  try {
    const body = await response.json() as unknown
    return (jsonRecord(body) ?? (Array.isArray(body) ? body : {}))
  } catch {
    throw new SwapGatewayError('ORDER_PROVIDER_INVALID', 'Jupiter returned an invalid response.', 502, true)
  }
}

function upstreamError(response: Response, requestId: string): SwapGatewayError {
  if (response.status === 429) return new SwapGatewayError('UPSTREAM_RATE_LIMITED', 'Price is refreshing. Try again in a moment.', 502, true)
  return new SwapGatewayError('UPSTREAM_UNAVAILABLE', `Jupiter request failed (${response.status}).`, 502, true)
}

function rowsFromProvider(body: Record<string, unknown> | unknown[]): Record<string, unknown>[] {
  const rows = Array.isArray(body)
    ? body
    : (Array.isArray(body.tokens) ? body.tokens : Array.isArray(body.data) ? body.data : null)
  if (rows === null) throw new SwapGatewayError('DISCOVERY_PROVIDER_INVALID', 'Jupiter returned an invalid token response.', 502, true)
  return rows.map(jsonRecord).filter((row): row is Record<string, unknown> => row !== null)
}

function tokenMint(row: Record<string, unknown>): string | null {
  const value = first(row.id, row.mint, row.address)
  return publicKey(value) ? value : null
}

function priceChange(row: Record<string, unknown>, key: string): number | null {
  const stats = jsonRecord(row[`stats${key}`])
  return signedFiniteOrNull(first(stats?.priceChange, stats?.price_change, row[`priceChange${key}`]))
}

function volume24h(row: Record<string, unknown>): number | null {
  const stats = jsonRecord(row.stats24h)
  const direct = finiteOrNull(first(stats?.volume, row.volume24h, row.volume24hUsd))
  if (direct !== null) return direct
  const buy = finiteOrNull(stats?.buyVolume)
  const sell = finiteOrNull(stats?.sellVolume)
  return buy !== null && sell !== null ? buy + sell : null
}

function normalizeWarning(row: Record<string, unknown>): SpotTokenSummary['warnings'] {
  const audit = jsonRecord(row.audit)
  const verified = row.isVerified === true ? 'verified' : row.isVerified === false ? 'unverified' : 'unknown'
  const organicRaw = String(first(row.organicScoreLabel, row.organicActivity) ?? '').toLowerCase()
  const organicActivity = organicRaw === 'high' || organicRaw === 'medium' || organicRaw === 'low' ? organicRaw : 'unknown'
  return { verification: verified, organicActivity, suspicious: audit?.isSus === true ? true : null }
}

const MIN_TERMINAL_LIQUIDITY_USD = 10_000

function hasSpamTag(row: Record<string, unknown>): boolean {
  return Array.isArray(row.tags)
    && row.tags.some((tag) => typeof tag === 'string' && ['spam', 'scam'].includes(tag.toLowerCase()))
}

function hasSupportedPool(row: Record<string, unknown>): boolean {
  const pool = jsonRecord(row.firstPool)
  return publicKey(pool?.id)
}

function isSearchEligible(row: Record<string, unknown>): boolean {
  return !hasSpamTag(row) && hasSupportedPool(row)
}

function isTerminalEligible(row: Record<string, unknown>): boolean {
  const liquidity = finiteOrNull(first(row.liquidity, row.liquidityUsd))
  const organic = String(first(row.organicScoreLabel, row.organicActivity) ?? '').toLowerCase()
  return isSearchEligible(row)
    && liquidity !== null
    && liquidity >= MIN_TERMINAL_LIQUIDITY_USD
    && (organic === 'high' || organic === 'medium')
}

async function normalizeTokenRows(
  rows: Record<string, unknown>[],
  identity: SwapIdentityService,
  query: string | null,
): Promise<{ items: SpotTokenSummary[]; partial: boolean }> {
  const mints = [...new Set(rows.map(tokenMint).filter((mint): mint is string => mint !== null))]
  let partial = mints.length !== rows.length
  try { await identity.warmMintIdentities?.(mints) } catch { partial = true }
  const items: SpotTokenSummary[] = []
  for (const row of rows) {
    const mint = tokenMint(row)
    if (!mint) continue
    const resolved = identity.resolveRef(`mint:${mint}`)
    if (resolved.mint !== mint || resolved.decimals === null) { partial = true; continue }
    const identityValue: TokenIdentity = {
      ...resolved,
      iconUrl: resolved.iconUrl && resolved.iconUrl.startsWith('/')
        ? resolved.iconUrl
        : null,
    }
    items.push({
      identity: identityValue,
      usdPrice: finiteOrNull(first(row.usdPrice, row.price)),
      momentumPct: { m5: priceChange(row, '5m'), h1: priceChange(row, '1h'), h6: priceChange(row, '6h'), h24: priceChange(row, '24h') },
      market: {
        marketCapUsd: finiteOrNull(first(row.mcap, row.marketCap, row.marketCapUsd)),
        liquidityUsd: finiteOrNull(first(row.liquidity, row.liquidityUsd)),
        volume24hUsd: volume24h(row),
      },
      warnings: normalizeWarning(row),
      updatedAt: isoStringOrNull(row.updatedAt),
    })
  }
  if (query && publicKey(query) && items.length > 1) {
    items.sort((a, b) => (a.identity.mint === query ? -1 : b.identity.mint === query ? 1 : 0))
  }
  return { items, partial }
}

function asRouter(value: unknown): SwapOrderBase['router'] {
  const router = String(value ?? '').toLowerCase()
  return router === 'metis' || router === 'jupiterz' || router === 'dflow' || router === 'okx' ? router : 'unknown'
}

function normalizeRoute(raw: unknown): Array<{ label: string; percent: number }> {
  if (!Array.isArray(raw)) return []
  return raw.map((part) => {
    const row = jsonRecord(part)
    const swapInfo = jsonRecord(row?.swapInfo)
    const percent = finiteOrNull(first(row?.percent, row?.percentage))
    const basisPoints = finiteOrNull(row?.bps)
    return {
      label: String(first(swapInfo?.label, swapInfo?.ammKey, row?.label, row?.dex, 'unknown')),
      percent: Math.min(100, percent ?? (basisPoints === null ? 0 : basisPoints / 100)),
    }
  })
}

function normalizedPriceImpactPct(raw: Record<string, unknown>): number | null {
  const priceImpact = numberValue(raw.priceImpact)
  if (priceImpact !== null) return priceImpact
  const deprecatedRatio = numberValue(raw.priceImpactPct)
  return deprecatedRatio === null ? null : deprecatedRatio * 100
}

function normalizeOrder(
  raw: Record<string, unknown>,
  request: SwapOrderRequest,
  requestId: string,
  priorityFeeMax: bigint,
): SwapOrderResponse {
  const transaction = stringValue(raw.transaction)
  const kind = request.taker ? 'signable' : 'quote'
  if (stringValue(raw.inputMint) !== request.inputMint || stringValue(raw.outputMint) !== request.outputMint) {
    throw new SwapGatewayError('ORDER_PROVIDER_INVALID', 'Jupiter returned mismatched swap assets.', 502, true)
  }
  if (request.taker && stringValue(raw.taker) !== request.taker) {
    throw new SwapGatewayError('ORDER_PROVIDER_INVALID', 'Jupiter returned a mismatched taker.', 502, true)
  }
  const providerFee = jsonRecord(first(raw.providerFee, raw.integratorFee, raw.platformFee))
  const providerFeeBps = finiteOrNull(first(raw.feeBps, raw.providerFeeBps, raw.platformFeeBps, providerFee?.feeBps, providerFee?.bps))
  const rawProviderFeeAtomic = boundedUint64(first(raw.providerFeeAtomic, raw.platformFeeAtomic, raw.feeAmount, providerFee?.amount))
  const rawProviderFeeMint = stringValue(first(raw.providerFeeMint, raw.feeMint, providerFee?.feeMint, providerFee?.mint))
  const providerFeeMint = publicKey(rawProviderFeeMint) ? rawProviderFeeMint : null
  if (providerFeeBps !== null && (!Number.isInteger(providerFeeBps) || providerFeeBps < 0 || providerFeeBps > 10_000)) {
    throw new SwapGatewayError('ORDER_PROVIDER_INVALID', 'Jupiter returned an invalid provider fee.', 502, true)
  }
  if (rawProviderFeeAtomic !== null && BigInt(rawProviderFeeAtomic) > 0n && providerFeeMint === null) {
    throw new SwapGatewayError('ORDER_PROVIDER_INVALID', 'Jupiter returned an invalid provider fee mint.', 502, true)
  }

  const inAmount = boundedUint64(first(raw.inAmount, raw.inAmountAtomic))
  if (inAmount === null) {
    throw new SwapGatewayError('ORDER_PROVIDER_INVALID', 'Jupiter returned an invalid input amount.', 502, true)
  }

  let providerFeeAtomic = rawProviderFeeAtomic
  if (inAmount !== request.amountAtomic) {
    const requested = BigInt(request.amountAtomic)
    const routed = BigInt(inAmount)
    const inputFeeDeducted = requested - routed
    const maximumInputFee = providerFeeBps === null
      ? 0n
      : (requested * BigInt(providerFeeBps) + 9_999n) / 10_000n

    // In input-fee routes Jupiter can return the amount that actually enters
    // the route after deducting its fee. The user's requested amount remains
    // the maximum wallet debit. Accept only that documented shape and only
    // within the provider's declared total fee rate; every other adjustment is
    // still rejected as an unsafe provider mismatch.
    if (
      providerFeeMint !== request.inputMint
      || providerFeeBps === null
      || providerFeeBps <= 0
      || inputFeeDeducted <= 0n
      || inputFeeDeducted > maximumInputFee
      || (rawProviderFeeAtomic !== null && BigInt(rawProviderFeeAtomic) > inputFeeDeducted)
    ) {
      throw new SwapGatewayError('ORDER_PROVIDER_INVALID', 'Jupiter returned a mismatched input amount.', 502, true)
    }
    providerFeeAtomic = inputFeeDeducted.toString()
  }
  const outAmountValue = integerString(first(raw.outAmount, raw.outAmountAtomic))
  if (outAmountValue === null || BigInt(outAmountValue) <= 0n) throw new SwapGatewayError('ORDER_PROVIDER_INVALID', 'Jupiter returned no output amount.', 502, true)
  const outAmount = outAmountValue
  const minimumOut = integerString(first(raw.otherAmountThreshold, raw.minimumOutAmount, raw.minimumOutAmountAtomic))
  if (minimumOut === null || BigInt(minimumOut) <= 0n || BigInt(minimumOut) > BigInt(outAmount)) {
    throw new SwapGatewayError('ORDER_PROVIDER_INVALID', 'Jupiter returned an invalid minimum output.', 502, true)
  }
  const priority = boundedUint64(first(raw.prioritizationFeeLamports, raw.priorityFeeLamports))
  if (priority !== null && BigInt(priority) > priorityFeeMax) {
    throw new SwapGatewayError('NETWORK_FEE_TOO_HIGH', 'Network fees are unusually high. Try again in a moment.', 422, true)
  }
  const fees = {
    providerFeeBps,
    providerFeeAtomic,
    providerFeeMint,
    signatureFeeLamports: boundedUint64(raw.signatureFeeLamports),
    priorityFeeLamports: priority,
    rentFeeLamports: boundedUint64(first(raw.rentFeeLamports, raw.rentFee)),
    myboonFeeAtomic: '0' as const,
    gasless: raw.gasless === true || raw.isGasless === true,
  }
  const normalizedSlippage = numberValue(first(raw.slippageBps, request.slippageBps))
  if (normalizedSlippage === null || !Number.isInteger(normalizedSlippage) || normalizedSlippage < 0 || normalizedSlippage > 5_000) {
    throw new SwapGatewayError('ORDER_PROVIDER_INVALID', 'Jupiter returned invalid slippage.', 502, true)
  }
  const base: SwapOrderBase = {
    requestId,
    inputMint: request.inputMint,
    outputMint: request.outputMint,
    inAmountAtomic: inAmount,
    outAmountAtomic: outAmount,
    minimumOutAmountAtomic: minimumOut,
    inUsdValue: finiteOrNull(first(raw.inUsdValue, raw.inputUsdValue, raw.swapUsdValue)),
    outUsdValue: finiteOrNull(first(raw.outUsdValue, raw.outputUsdValue)),
    priceImpactPct: normalizedPriceImpactPct(raw),
    slippageBps: normalizedSlippage,
    router: asRouter(first(raw.router, raw.routerName)),
    route: normalizeRoute(first(raw.routePlan, raw.route)),
    fees,
    expiresAt: isoStringOrNull(first(raw.expireAt, raw.expiresAt)),
  }
  if (kind === 'quote') {
    return { ...base, kind: 'quote', taker: null, transaction: null, lastValidBlockHeight: null }
  }
  if (!transaction) throw new SwapGatewayError('ORDER_PROVIDER_INVALID', 'Jupiter returned no signable transaction.', 502, true)
  const lastValid = boundedUint64(first(raw.lastValidBlockHeight, raw.lastValidBlockheight))
  if (!lastValid) throw new SwapGatewayError('ORDER_PROVIDER_INVALID', 'Jupiter returned no block-height expiry.', 502, true)
  return { ...base, kind: 'signable', taker: request.taker!, transaction, lastValidBlockHeight: lastValid }
}

function refusalCode(raw: Record<string, unknown>, request: SwapOrderRequest): string | null {
  if (!request.taker || stringValue(raw.transaction)) return null
  const router = asRouter(first(raw.router, raw.routerName))
  const code = numberValue(first(raw.errorCode, raw.code))
  if (code === null) return 'ORDER_PROVIDER_INVALID'
  if (code === 1 && router !== 'unknown') return 'INSUFFICIENT_FUNDS'
  if (code === 2 && router === 'jupiterz') return 'TOKEN_ACCOUNT_REQUIRED'
  if (code === 2 && (router === 'metis' || router === 'dflow' || router === 'okx')) return 'INSUFFICIENT_SOL_FOR_FEES'
  if (code === 3 && (router === 'metis' || router === 'dflow' || router === 'okx')) return 'ORDER_BELOW_MINIMUM'
  if (code === 3 && router === 'jupiterz') return 'ORDER_BUILD_FAILED'
  return 'ORDER_BUILD_FAILED'
}

function refusalMessage(code: string): string {
  switch (code) {
    case 'INSUFFICIENT_FUNDS': return 'The wallet does not have enough of the input token for this trade.'
    case 'INSUFFICIENT_SOL_FOR_FEES': return 'Add SOL for network, priority-fee, and account-creation costs.'
    case 'TOKEN_ACCOUNT_REQUIRED': return 'A required token account could not be prepared for this route.'
    case 'ORDER_BELOW_MINIMUM': return 'The trade amount is below the route minimum.'
    default: return 'Jupiter could not build this order. Review a fresh quote.'
  }
}

function executeResponseFromRecord(record: SwapExecutionRecord): SwapExecuteResponse {
  return {
    outcome: record.outcome,
    signature: record.signature,
    slot: record.slot,
    code: record.code,
    message: record.message,
    totalInputAmountAtomic: record.totalInputAmountAtomic,
    totalOutputAmountAtomic: record.totalOutputAmountAtomic,
    inputAmountResultAtomic: record.inputAmountResultAtomic,
    outputAmountResultAtomic: record.outputAmountResultAtomic,
  }
}

function executeMessage(code: number | null, providerMessage: string | null): string | null {
  switch (code) {
    case 6001: return 'Price moved beyond the reviewed slippage limit. Review a fresh quote.'
    case -1: return 'The swap order expired or is no longer available. Review a fresh quote.'
    case -2:
    case -3:
    case -1002: return 'The signed transaction was invalid. Review a fresh transaction before trying again.'
    case -1003: return 'The wallet did not fully sign the transaction.'
    case -1004:
    case -2003: return 'The transaction or quote expired. Review a fresh quote.'
    case -1005: return 'The submitted transaction expired before it landed. Review a fresh quote.'
    case -1006: return 'The submitted transaction timed out before confirmation. Check its explorer status, then review a fresh quote.'
    case -1007: return 'This wallet is not supported by the routed gasless transaction. Review a fresh route.'
    case -1000:
    case -2000: return 'The transaction could not land. Network congestion or the priority-fee ceiling may be the cause; review a fresh quote.'
    case -2002: return 'The routed trade payload was rejected. Review a fresh quote.'
    case -2004: return 'The routed trade was rejected before completion. Review a fresh quote.'
    case -2005: return 'The routed trade failed internally. Review a fresh quote.'
    default: return providerMessage
  }
}

function parseExecute(raw: Record<string, unknown>): SwapExecuteResponse | null {
  const status = String(raw.status ?? '').toLowerCase()
  const parsedCode = numberValue(raw.code)
  const code = parsedCode !== null && Number.isInteger(parsedCode) ? parsedCode : null
  const signature = stringValue(first(raw.signature, raw.txid, raw.transactionSignature))
  const outcome = status === 'success' && code === 0 && signature
    ? 'confirmed'
    : status === 'failed' && code !== null && code !== -1001 && code !== -2001
      ? 'failed'
      : status === 'success' || status === 'failed' || code === -1001 || code === -2001
        ? 'unknown'
        : null
  if (!outcome) return null
  const providerMessage = stringValue(first(raw.error, raw.errorMessage, raw.message))
  return {
    outcome,
    signature,
    slot: integerString(raw.slot),
    code,
    message: executeMessage(code, providerMessage),
    totalInputAmountAtomic: integerString(raw.totalInputAmount),
    totalOutputAmountAtomic: integerString(raw.totalOutputAmount),
    inputAmountResultAtomic: integerString(raw.inputAmountResult),
    outputAmountResultAtomic: integerString(raw.outputAmountResult),
  }
}

function routePath(base: string, path: string): string { return `${base.replace(/\/+$/, '')}${path}` }

export function createSwapRoutes(config: CreateSwapRoutesConfig): Hono {
  const routes = new Hono()
  const fetchImpl = config.fetchImpl ?? globalThis.fetch
  const base = config.jupApiBase ?? DEFAULT_JUP_API_BASE
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (config.jupApiKey) headers['x-api-key'] = config.jupApiKey
  // Unit callers may inject an identity resolver without making an incidental
  // network lookup. The production app passes the warm function explicitly so
  // long-tail mints are enriched through the existing shared cache.
  const identity = config.identity ?? { resolveRef }
  const store = config.store ?? createMemorySwapExecutionStore()
  const priorityFeeMax = normalizePriorityFee(config.priorityFeeMaxLamports)
  const tradingEnabled = config.tradingEnabled ?? true
  const observe = config.observe ?? (() => {})
  const limits: SwapRateLimits = {
    discovery: config.rateLimits?.discovery ?? 60,
    quote: config.rateLimits?.quote ?? 30,
    signable: config.rateLimits?.signable ?? 10,
    execute: config.rateLimits?.execute ?? 5,
    windowMs: config.rateLimits?.windowMs ?? 60_000,
  }
  const requestWindows = new Map<string, number[]>()
  const listCache = new Map<string, CacheEntry<SpotTokenListResponse>>()
  const searchCache = new Map<string, CacheEntry<SpotTokenSearchResponse>>()
  const priceCache = new Map<string, CacheEntry<SpotPriceResponse>>()
  const quoteCache = new Map<string, CacheEntry<Extract<SwapOrderResponse, { kind: 'quote' }>>>()
  const quoteInflight = new Map<string, Promise<Record<string, unknown> | unknown[]>>()
  const activeExecutions = new Set<string>()
  let rateChecks = 0

  function allow(c: { req: { header(name: string): string | undefined } }, budget: SwapRateBudget): boolean {
    const now = Date.now()
    rateChecks += 1
    if (rateChecks % 256 === 0 || requestWindows.size > 5_000) {
      for (const [key, timestamps] of requestWindows) {
        const live = timestamps.filter((at) => now - at < limits.windowMs)
        if (live.length === 0) requestWindows.delete(key)
        else requestWindows.set(key, live)
      }
    }
    const sessionLimit = limits[budget]
    const ipLimit = Math.max(sessionLimit * 5, 20)
    const windows = [
      { key: `${budget}:session:${clientSession(c)}`, limit: sessionLimit },
      { key: `${budget}:ip:${clientIp(c)}`, limit: ipLimit },
    ].map((entry) => ({ ...entry, recent: (requestWindows.get(entry.key) ?? []).filter((at) => now - at < limits.windowMs) }))
    if (windows.some((entry) => entry.recent.length >= entry.limit)) {
      for (const entry of windows) requestWindows.set(entry.key, entry.recent)
      return false
    }
    for (const entry of windows) requestWindows.set(entry.key, [...entry.recent, now])
    return true
  }

  async function providerGet(path: string, requestId: string): Promise<Record<string, unknown> | unknown[]> {
    let response: Response
    try { response = await fetchWithTimeout(fetchImpl, routePath(base, path), { headers }) }
    catch { throw new SwapGatewayError('UPSTREAM_UNAVAILABLE', 'Jupiter is unavailable.', 502, true) }
    if (!response.ok) throw upstreamError(response, requestId)
    return parseProviderBody(response)
  }

  async function providerPost(path: string, body: Record<string, unknown>): Promise<{ response: Response; body: Record<string, unknown> | unknown[] }> {
    let response: Response
    try {
      response = await fetchWithTimeout(fetchImpl, routePath(base, path), {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
    } catch {
      throw new SwapGatewayError('EXECUTE_UNKNOWN', 'Submission outcome is unknown. Check the transaction before trying again.', 202, true)
    }
    let parsed: Record<string, unknown> | unknown[]
    try { parsed = await parseProviderBody(response) } catch {
      throw new SwapGatewayError('EXECUTE_UNKNOWN', 'Submission outcome is unknown. Check the transaction before trying again.', 202, true)
    }
    return { response, body: parsed }
  }

  routes.get('/tokens', async (c) => {
    const requestId = requestIdFrom(c)
    const startedAt = Date.now()
    if (!allow(c, 'discovery')) return errorResponse(c, new SwapGatewayError('RATE_LIMITED', 'Token discovery is rate limited.', 429, true), requestId)
    const rawLimit = c.req.query('limit') ?? '30'
    if (!/^[0-9]+$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 50) {
      return errorResponse(c, new SwapGatewayError('INVALID_LIMIT', 'limit must be an integer from 1 through 50.', 400), requestId)
    }
    const limit = Number(rawLimit)
    const key = String(limit)
    const cached = listCache.get(key)
    if (cached && cached.expiresAt > Date.now()) return c.json(cached.value)
    try {
      const body = await providerGet(`/tokens/v2/toptrending/1h?limit=${limit}`, requestId)
      const normalized = await normalizeTokenRows(rowsFromProvider(body).filter(isTerminalEligible), identity, null)
      const result: SpotTokenListResponse = { items: normalized.items, ranking: 'toptrending_1h', asOf: nowIso(), partial: normalized.partial }
      listCache.set(key, { value: result, expiresAt: Date.now() + 30_000 })
      observe({ event: 'discovery', at: nowIso(), requestId, ok: true, durationMs: Date.now() - startedAt, itemCount: result.items.length, partial: result.partial })
      return c.json(result)
    } catch (error) {
      const gatewayError = error instanceof SwapGatewayError ? error : new SwapGatewayError('DISCOVERY_UNAVAILABLE', 'Token discovery is unavailable.', 502, true)
      observe({ event: 'discovery', at: nowIso(), requestId, ok: false, durationMs: Date.now() - startedAt, code: gatewayError.code })
      return errorResponse(c, gatewayError, requestId)
    }
  })

  routes.get('/tokens/search', async (c) => {
    const requestId = requestIdFrom(c)
    if (!allow(c, 'discovery')) return errorResponse(c, new SwapGatewayError('RATE_LIMITED', 'Token discovery is rate limited.', 429, true), requestId)
    const query = (c.req.query('query') ?? '').trim()
    if (query.length < 1 || query.length > 120) return errorResponse(c, new SwapGatewayError('INVALID_QUERY', 'query must contain 1 through 120 characters.', 400), requestId)
    const key = query.toLowerCase()
    const cached = searchCache.get(key)
    if (cached && cached.expiresAt > Date.now()) return c.json(cached.value)
    try {
      const body = await providerGet(`/tokens/v2/search?query=${encodeURIComponent(query)}`, requestId)
      const normalized = await normalizeTokenRows(rowsFromProvider(body).filter(isSearchEligible).slice(0, 20), identity, query)
      const result: SpotTokenSearchResponse = { query, items: normalized.items, asOf: nowIso(), partial: normalized.partial }
      searchCache.set(key, { value: result, expiresAt: Date.now() + 5 * 60_000 })
      return c.json(result)
    } catch (error) {
      return errorResponse(c, error instanceof SwapGatewayError ? error : new SwapGatewayError('SEARCH_UNAVAILABLE', 'Token search is unavailable.', 502, true), requestId)
    }
  })

  routes.get('/prices', async (c) => {
    const requestId = requestIdFrom(c)
    if (!allow(c, 'discovery')) return errorResponse(c, new SwapGatewayError('RATE_LIMITED', 'Price lookup is rate limited.', 429, true), requestId)
    const rawIds = c.req.query('ids') ?? ''
    const ids = rawIds.split(',').map((id) => id.trim()).filter(Boolean)
    const unique = [...new Set(ids)]
    if (ids.length < 1 || ids.length > 50 || unique.length !== ids.length || unique.length > 50 || unique.some((id) => !publicKey(id))) {
      return errorResponse(c, new SwapGatewayError('INVALID_MINTS', 'ids must contain 1 through 50 canonical Solana mints.', 400), requestId)
    }
    const key = unique.join(',')
    const cached = priceCache.get(key)
    if (cached && cached.expiresAt > Date.now()) return c.json(cached.value)
    try {
      const body = await providerGet(`/price/v3?ids=${encodeURIComponent(key)}`, requestId)
      const root = jsonRecord(body) ?? {}
      const map = jsonRecord(root.data) ?? root
      const prices = unique.map((mint) => {
        const row = jsonRecord(map[mint])
        return { mint, usdPrice: finiteOrNull(row?.usdPrice), blockId: nonnegativeSafeIntegerOrNull(row?.blockId) }
      })
      const result: SpotPriceResponse = { prices, asOf: nowIso() }
      priceCache.set(key, { value: result, expiresAt: Date.now() + 15_000 })
      return c.json(result)
    } catch (error) {
      return errorResponse(c, error instanceof SwapGatewayError ? error : new SwapGatewayError('PRICE_UNAVAILABLE', 'Price lookup is unavailable.', 502, true), requestId)
    }
  })

  routes.post('/order', async (c) => {
    const requestId = requestIdFrom(c)
    const startedAt = Date.now()
    let body: Record<string, unknown>
    try { body = await readJson(c) } catch (error) { return errorResponse(c, error as SwapGatewayError, requestId) }
    try {
      assertOnlyFields(body, ['inputMint', 'outputMint', 'amountAtomic', 'taker', 'slippageBps'])
      if (!publicKey(body.inputMint) || !publicKey(body.outputMint)) throw new SwapGatewayError('INVALID_MINT', 'inputMint and outputMint must be valid Solana public keys.', 400)
      if (body.inputMint === body.outputMint) throw new SwapGatewayError('SAME_MINT', 'inputMint and outputMint must differ.', 400)
      if (!positiveUint64(body.amountAtomic)) throw new SwapGatewayError('INVALID_AMOUNT', 'amountAtomic must be a positive uint64 decimal string.', 400)
      if (body.taker !== undefined && !publicKey(body.taker)) throw new SwapGatewayError('INVALID_TAKER', 'taker must be a valid Solana public key.', 400)
      if (body.slippageBps !== undefined && (!Number.isInteger(body.slippageBps) || Number(body.slippageBps) < 0 || Number(body.slippageBps) > 5000)) {
        throw new SwapGatewayError('INVALID_SLIPPAGE', 'slippageBps must be an integer from 0 through 5000.', 400)
      }
      const request: SwapOrderRequest = {
        inputMint: body.inputMint as string,
        outputMint: body.outputMint as string,
        amountAtomic: body.amountAtomic as string,
        ...(body.taker !== undefined ? { taker: body.taker as string } : {}),
        ...(body.slippageBps !== undefined ? { slippageBps: body.slippageBps as number } : {}),
      }
      const budget: SwapRateBudget = request.taker ? 'signable' : 'quote'
      if (!allow(c, budget)) return errorResponse(c, new SwapGatewayError('RATE_LIMITED', 'Swap requests are rate limited.', 429, true), requestId)
      if (request.taker && !tradingEnabled) return errorResponse(c, new SwapGatewayError('TRADING_PAUSED', 'Trading is temporarily paused.', 503, true), requestId)
      const params = new URLSearchParams({
        inputMint: request.inputMint,
        outputMint: request.outputMint,
        amount: request.amountAtomic,
      })
      if (request.taker) params.set('taker', request.taker)
      if (request.slippageBps !== undefined) params.set('slippageBps', String(request.slippageBps))
      const providerPath = `/swap/v2/order?${params.toString()}`
      const quoteKey = request.taker
        ? null
        : `${request.inputMint}:${request.outputMint}:${request.amountAtomic}:${request.slippageBps ?? 'auto'}`
      if (quoteKey) {
        const cached = quoteCache.get(quoteKey)
        if (cached && cached.expiresAt > Date.now()) return c.json(cached.value)
      }
      let rawPromise = quoteKey ? quoteInflight.get(quoteKey) : undefined
      if (!rawPromise) {
        rawPromise = providerGet(providerPath, requestId)
        if (quoteKey) {
          quoteInflight.set(quoteKey, rawPromise)
          void rawPromise.finally(() => quoteInflight.delete(quoteKey)).catch(() => undefined)
        }
      }
      const rawBody = await rawPromise
      const raw = jsonRecord(rawBody)
      if (!raw) throw new SwapGatewayError('ORDER_PROVIDER_INVALID', 'Jupiter returned an invalid order.', 502, true)
      const refusal = refusalCode(raw, request)
      if (refusal) {
        const status = refusal === 'ORDER_PROVIDER_INVALID' ? 502 : 422
        throw new SwapGatewayError(refusal, refusalMessage(refusal), status as 422 | 502, status === 502)
      }
      const providerRequestId = stringValue(raw.requestId)
      if (request.taker && !providerRequestId) throw new SwapGatewayError('ORDER_PROVIDER_INVALID', 'Jupiter returned no execution request ID.', 502, true)
      const normalized = normalizeOrder(raw, request, providerRequestId ?? requestId, priorityFeeMax)
      if (quoteKey && normalized.kind === 'quote') {
        quoteCache.set(quoteKey, { value: normalized, expiresAt: Date.now() + QUOTE_CACHE_MS })
      }
      if (normalized.kind === 'signable') {
        store.saveOrder({ requestId: normalized.requestId, inputMint: normalized.inputMint, outputMint: normalized.outputMint, taker: normalized.taker, lastValidBlockHeight: normalized.lastValidBlockHeight, createdAt: nowIso() })
      }
      observe({ event: 'order', at: nowIso(), requestId: normalized.requestId, ok: true, durationMs: Date.now() - startedAt, orderKind: normalized.kind })
      return c.json(normalized)
    } catch (error) {
      const gatewayError = error instanceof SwapGatewayError ? error : new SwapGatewayError('ORDER_UNAVAILABLE', 'Swap order is unavailable.', 502, true)
      observe({ event: 'order', at: nowIso(), requestId, ok: false, durationMs: Date.now() - startedAt, code: gatewayError.code, orderKind: body.taker ? 'signable' : 'quote' })
      return errorResponse(c, gatewayError, requestId)
    }
  })

  routes.post('/execute', async (c) => {
    const requestId = requestIdFrom(c)
    const startedAt = Date.now()
    if (!allow(c, 'execute')) return errorResponse(c, new SwapGatewayError('RATE_LIMITED', 'Swap execution is rate limited.', 429, true), requestId)
    let body: Record<string, unknown>
    try { body = await readJson(c) } catch (error) { return errorResponse(c, error as SwapGatewayError, requestId) }
    try {
      assertOnlyFields(body, ['signedTransaction', 'requestId', 'lastValidBlockHeight'])
      const signed = body.signedTransaction
      const executionRequestId = body.requestId
      if (typeof signed !== 'string' || signed.length === 0 || signed.length > 100_000 || !BASE64_RE.test(signed)) throw new SwapGatewayError('INVALID_TRANSACTION', 'signedTransaction must be base64.', 400)
      if (typeof executionRequestId !== 'string' || executionRequestId.length < 1 || executionRequestId.length > 120) throw new SwapGatewayError('INVALID_REQUEST_ID', 'requestId is required.', 400)
      const lastValid = body.lastValidBlockHeight === undefined
        ? null
        : (typeof body.lastValidBlockHeight === 'string' ? boundedUint64(body.lastValidBlockHeight) : null)
      if (body.lastValidBlockHeight !== undefined && lastValid === null) throw new SwapGatewayError('INVALID_BLOCK_HEIGHT', 'lastValidBlockHeight must be a uint64 decimal string.', 400)
      const order = store.getOrder(executionRequestId)
      if (!order) throw new SwapGatewayError('ORDER_NOT_FOUND', 'The order request could not be found; review the trade again.', 409)
      if (lastValid !== null && order.lastValidBlockHeight !== null && lastValid !== order.lastValidBlockHeight) {
        throw new SwapGatewayError('BLOCK_HEIGHT_MISMATCH', 'lastValidBlockHeight does not match the reviewed order.', 400)
      }
      const prior = store.getExecution(executionRequestId)
      if (prior) {
        const previous = executeResponseFromRecord(prior)
        return c.json(previous, prior.outcome === 'unknown' ? 202 : 200)
      }
      if (activeExecutions.has(executionRequestId)) {
        throw new SwapGatewayError('DUPLICATE_EXECUTION', 'This trade is already being submitted.', 409, true)
      }
      activeExecutions.add(executionRequestId)
      // Claim the request durably before crossing the submission boundary.
      // If this process stops after Jupiter receives the transaction, a later
      // request observes `unknown` instead of broadcasting the same signed
      // transaction a second time.
      store.saveExecution({
        requestId: executionRequestId,
        outcome: 'unknown',
        signature: null,
        slot: null,
        code: null,
        message: 'Submission started; confirmation is pending.',
        totalInputAmountAtomic: null,
        totalOutputAmountAtomic: null,
        inputAmountResultAtomic: null,
        outputAmountResultAtomic: null,
        updatedAt: nowIso(),
      })
      let provider: { response: Response; body: Record<string, unknown> | unknown[] }
      try {
        provider = await providerPost('/swap/v2/execute', {
          signedTransaction: signed,
          requestId: executionRequestId,
          ...(lastValid !== null || order.lastValidBlockHeight !== null
            ? { lastValidBlockHeight: lastValid ?? order.lastValidBlockHeight }
            : {}),
        })
      } catch (error) {
        const unknown: SwapExecuteResponse = { outcome: 'unknown', signature: null, slot: null, code: null, message: 'Submission outcome is unknown. Check the transaction before trying again.', totalInputAmountAtomic: null, totalOutputAmountAtomic: null, inputAmountResultAtomic: null, outputAmountResultAtomic: null }
        store.saveExecution({ ...unknown, requestId: executionRequestId, updatedAt: nowIso() })
        activeExecutions.delete(executionRequestId)
        observe({ event: 'execute', at: nowIso(), requestId: executionRequestId, ok: false, durationMs: Date.now() - startedAt, outcome: 'unknown', code: 'EXECUTE_UNKNOWN' })
        return c.json(unknown, 202)
      }
      const parsed = jsonRecord(provider.body)
      const normalized = parsed ? parseExecute(parsed) : null
      if (!normalized) {
        // A provider 4xx with no terminal status proves the request was
        // rejected before landing; it is safe to correct and retry. A 5xx or
        // malformed post-dispatch body remains deliberately unknown.
        if (provider.response.status >= 400 && provider.response.status < 500) {
          throw new SwapGatewayError('EXECUTE_PROVIDER_REJECTED', 'Jupiter rejected the signed transaction before submission.', 502, true)
        }
        const unknown: SwapExecuteResponse = { outcome: 'unknown', signature: null, slot: null, code: null, message: 'Submission outcome is unknown. Check the transaction before trying again.', totalInputAmountAtomic: null, totalOutputAmountAtomic: null, inputAmountResultAtomic: null, outputAmountResultAtomic: null }
        store.saveExecution({ ...unknown, requestId: executionRequestId, updatedAt: nowIso() })
        activeExecutions.delete(executionRequestId)
        observe({ event: 'execute', at: nowIso(), requestId: executionRequestId, ok: false, durationMs: Date.now() - startedAt, outcome: 'unknown', code: 'EXECUTE_PROVIDER_INVALID' })
        return c.json(unknown, 202)
      }
      store.saveExecution({ ...normalized, requestId: executionRequestId, updatedAt: nowIso() })
      activeExecutions.delete(executionRequestId)
      observe({ event: 'execute', at: nowIso(), requestId: executionRequestId, ok: normalized.outcome === 'confirmed', durationMs: Date.now() - startedAt, outcome: normalized.outcome, ...(normalized.code === null ? {} : { code: String(normalized.code) }) })
      return c.json(normalized, normalized.outcome === 'unknown' ? 202 : 200)
    } catch (error) {
      if (typeof body === 'object' && body !== null && typeof body.requestId === 'string') activeExecutions.delete(body.requestId)
      const gatewayError = error instanceof SwapGatewayError ? error : new SwapGatewayError('EXECUTE_UNAVAILABLE', 'Swap execution is unavailable.', 502, true)
      observe({ event: 'execute', at: nowIso(), requestId: typeof body.requestId === 'string' ? body.requestId : requestId, ok: false, durationMs: Date.now() - startedAt, code: gatewayError.code })
      return errorResponse(c, gatewayError, requestId)
    }
  })

  return routes
}

export { createMemorySwapExecutionStore }
