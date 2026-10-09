import type {
  SeedToken,
  SeedTokenSnapshot,
  WalletActivity,
  WalletActivityResult,
  WalletActivityService,
  WalletLabel,
} from './types.js'

const DEFAULT_API_BASE = 'https://public-api.birdeye.so'
const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000
const DEFAULT_MAX_STALE_MS = 6 * 60 * 60 * 1000
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000
const DEFAULT_REQUEST_SPACING_MS = 1250
const DEFAULT_REQUEST_TIMEOUT_MS = 8_000
const DEFAULT_REFRESH_DEADLINE_MS = 25_000
const DEFAULT_MAX_RESPONSE_BYTES = 1_000_000
const MAX_RESPONSE_ROWS = 100
const LOOKBACK_DAYS = 30
const LOOKBACK_SECONDS = LOOKBACK_DAYS * 24 * 60 * 60
const MAX_SEEDS = 3
const MAX_WALLETS = 3
const MAX_ACTIVITIES = 20

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/

type FetchLike = typeof fetch
type Sleep = (milliseconds: number) => Promise<void>

export type WalletActivityServiceOptions = {
  apiKey?: string
  apiBaseUrl?: string
  getSeedTokens: () => SeedTokenSnapshot | Promise<SeedTokenSnapshot>
  fetchImpl?: FetchLike
  now?: () => number
  sleep?: Sleep
  cacheTtlMs?: number
  maxStaleMs?: number
  cooldownMs?: number
  requestSpacingMs?: number
  requestTimeoutMs?: number
  refreshDeadlineMs?: number
  maxResponseBytes?: number
}

type SeedContext = {
  seed: SeedToken
  labels: WalletLabel[]
}

type Holder = {
  walletAddress: string
  contexts: Map<string, SeedContext>
}

type InternalError = {
  code: string
  retryable: boolean
  message: string
}

class ProviderError extends Error {
  readonly code: string
  readonly retryable: boolean
  readonly rateLimited: boolean

  constructor(code: string, message: string, retryable = true, rateLimited = false) {
    super(message)
    this.name = 'ProviderError'
    this.code = code
    this.retryable = retryable
    this.rateLimited = rateLimited
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function positiveNumber(value: unknown): number | null {
  if (isFiniteNumber(value) && value > 0) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return null
}

function finiteNumber(value: unknown): number | null {
  if (isFiniteNumber(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function validAddress(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 32 && value.length <= 44 && BASE58.test(value)
}

function validSignature(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 64 && value.length <= 90 && BASE58.test(value)
}

function normalizeIsoSeconds(value: unknown, nowMs: number, lookbackSeconds = LOOKBACK_SECONDS): string | null {
  let seconds = finiteNumber(value)
  if (seconds === null) return null
  if (seconds > 20_000_000_000) seconds /= 1000
  if (!Number.isFinite(seconds) || seconds < nowMs / 1000 - lookbackSeconds || seconds > nowMs / 1000) return null
  const date = new Date(seconds * 1000)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

function normalizeLabels(value: unknown): WalletLabel[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : []
  const found = new Set<WalletLabel>()
  for (const label of raw) {
    const normalized = String(label).trim().toLowerCase()
    if (normalized === 'kol') found.add('kol')
    if (normalized === 'smart_trader' || normalized === 'smart trader') found.add('smart_trader')
  }
  return (['kol', 'smart_trader'] as WalletLabel[]).filter((label) => found.has(label))
}

function mergeLabels(a: readonly WalletLabel[], b: readonly WalletLabel[]): WalletLabel[] {
  return (['kol', 'smart_trader'] as WalletLabel[]).filter((label) => a.includes(label) || b.includes(label))
}

function dedupeSeeds(snapshot: SeedTokenSnapshot): SeedToken[] {
  const seen = new Set<string>()
  const out: SeedToken[] = []
  for (const token of snapshot.tokens ?? []) {
    if (!token || !validAddress(token.address) || seen.has(token.address)) continue
    if (token.address === USDC || token.address === USDT) continue
    const symbol = typeof token.symbol === 'string' ? token.symbol.trim() : ''
    const name = typeof token.name === 'string' ? token.name.trim() : ''
    if (!symbol || !name) continue
    seen.add(token.address)
    out.push({ address: token.address, symbol, name })
    if (out.length === MAX_SEEDS) break
  }
  return out
}

function errorFrom(error: unknown): InternalError {
  if (error instanceof ProviderError) return { code: error.code, retryable: error.retryable, message: error.message }
  return { code: 'PROVIDER_UNAVAILABLE', retryable: true, message: 'Birdeye is temporarily unavailable' }
}

function sanitizedMessage(error: InternalError): string {
  return error.message.length > 160 ? error.message.slice(0, 160) : error.message
}

function withError(result: WalletActivityResult, error: InternalError): WalletActivityResult {
  return { ...result, error: { ...error, message: sanitizedMessage(error) } }
}

function seedTimestampState(value: string | null, referenceMs: number): 'fresh' | 'stale' | null {
  if (!value) return null
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) return null
  const age = referenceMs - parsed
  if (age < -60_000 || age > 30 * 60_000) return null
  return age > 5 * 60_000 ? 'stale' : 'fresh'
}

function responseRows(body: unknown, kind: 'holders' | 'trades'): unknown[] {
  const root = asRecord(body)
  if (root?.success !== true) throw new ProviderError('BIRDEYE_MALFORMED_RESPONSE', 'Birdeye returned malformed data')
  const data = root.data
  const dataRecord = asRecord(data)
  const rows = kind === 'holders'
    ? (Array.isArray(data) ? data : null)
    : (dataRecord && Array.isArray(dataRecord.items) ? dataRecord.items : null)
  if (!rows || rows.length > MAX_RESPONSE_ROWS) {
    throw new ProviderError('BIRDEYE_MALFORMED_RESPONSE', 'Birdeye returned malformed data')
  }
  return rows
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
}

export function createWalletActivityService(options: WalletActivityServiceOptions): WalletActivityService {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const now = options.now ?? (() => Date.now())
  const sleep = options.sleep ?? delay
  const apiBase = (options.apiBaseUrl ?? DEFAULT_API_BASE).replace(/\/$/, '')
  const cacheTtlMs = Math.max(0, options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS)
  const maxStaleMs = Math.max(cacheTtlMs, options.maxStaleMs ?? DEFAULT_MAX_STALE_MS)
  const cooldownMs = Math.max(0, options.cooldownMs ?? DEFAULT_COOLDOWN_MS)
  const requestSpacingMs = Math.max(0, options.requestSpacingMs ?? DEFAULT_REQUEST_SPACING_MS)
  const requestTimeoutMs = Math.max(1, options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS)
  const refreshDeadlineMs = Math.max(1, Math.min(29_000, options.refreshDeadlineMs ?? DEFAULT_REFRESH_DEADLINE_MS))
  const maxResponseBytes = Math.max(1, options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES)

  let cached: { result: WalletActivityResult; storedAt: number } | null = null
  let lastGood: { result: WalletActivityResult; storedAt: number } | null = null
  let failureCache: { result: WalletActivityResult; retryAt: number } | null = null
  let inFlight: Promise<WalletActivityResult> | null = null
  let cooldownUntil = 0
  let blockedError: InternalError | null = null
  let lastRequestAt = 0

  function newestUsableSnapshot() {
    return [cached, lastGood]
      .filter((entry): entry is NonNullable<typeof cached> => Boolean(entry) && now() - entry!.storedAt <= maxStaleMs)
      .sort((a, b) => b.storedAt - a.storedAt)[0] ?? null
  }

  async function boundedWait(milliseconds: number, deadlineAt: number): Promise<void> {
    const remaining = deadlineAt - now()
    if (remaining <= 0) throw new ProviderError('BIRDEYE_REFRESH_TIMEOUT', 'Birdeye refresh timed out')
    const waitFor = Math.min(milliseconds, remaining)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        sleep(waitFor),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new ProviderError('BIRDEYE_REFRESH_TIMEOUT', 'Birdeye refresh timed out')), waitFor)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async function readBoundedText(response: Response, signal: AbortSignal): Promise<string> {
    if (!response.body) {
      let abort: (() => void) | undefined
      try {
        const text = await Promise.race([
          response.text(),
          new Promise<string>((_, reject) => {
            abort = () => reject(new ProviderError('BIRDEYE_TIMEOUT', 'Birdeye request timed out'))
            signal.addEventListener('abort', abort, { once: true })
          }),
        ])
        if (new TextEncoder().encode(text).byteLength > maxResponseBytes) throw new ProviderError('BIRDEYE_RESPONSE_TOO_LARGE', 'Birdeye response was too large')
        return text
      } finally {
        if (abort) signal.removeEventListener('abort', abort)
      }
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    const chunks: string[] = []
    let bytes = 0
    const cancel = () => { void reader.cancel().catch(() => undefined) }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      while (true) {
        if (signal.aborted) throw new ProviderError('BIRDEYE_TIMEOUT', 'Birdeye request timed out')
        const next = await reader.read()
        if (next.done) break
        bytes += next.value.byteLength
        if (bytes > maxResponseBytes) throw new ProviderError('BIRDEYE_RESPONSE_TOO_LARGE', 'Birdeye response was too large')
        chunks.push(decoder.decode(next.value, { stream: true }))
      }
      chunks.push(decoder.decode())
      return chunks.join('')
    } finally {
      signal.removeEventListener('abort', cancel)
      try { await reader.cancel() } catch { /* best effort */ }
    }
  }

  function retryAfterMs(response: Response): number {
    const value = response.headers.get('retry-after')
    if (!value) return cooldownMs
    const seconds = Number(value)
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(24 * 60 * 60 * 1000, seconds * 1000)
    const date = Date.parse(value)
    return Number.isFinite(date) ? Math.max(0, Math.min(24 * 60 * 60 * 1000, date - now())) : cooldownMs
  }

  async function providerRequest(path: string, deadlineAt: number, onSuccess: (completedAt: number) => void): Promise<unknown> {
    if (blockedError) throw new ProviderError(blockedError.code, blockedError.message, blockedError.retryable)
    if (now() < cooldownUntil) throw new ProviderError('BIRDEYE_COOLDOWN', 'Birdeye rate limit cooldown is active', true, true)
    const waitFor = lastRequestAt === 0 ? 0 : Math.max(0, requestSpacingMs - (now() - lastRequestAt))
    if (waitFor > 0) await boundedWait(waitFor, deadlineAt)
    if (now() >= deadlineAt) throw new ProviderError('BIRDEYE_REFRESH_TIMEOUT', 'Birdeye refresh timed out')
    lastRequestAt = now()
    const controller = new AbortController()
    const timeoutMs = Math.min(requestTimeoutMs, Math.max(1, deadlineAt - now()))
    let timeout: ReturnType<typeof setTimeout> | undefined
    let response: Response
    try {
      const request = fetchImpl(`${apiBase}${path}`, { headers: { accept: 'application/json', 'X-API-KEY': options.apiKey ?? '', 'x-chain': 'solana' }, redirect: 'error', signal: controller.signal })
      const timeoutError = new Promise<Response>((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort()
          reject(new ProviderError('BIRDEYE_TIMEOUT', 'Birdeye request timed out'))
        }, timeoutMs)
      })
      response = await Promise.race([request, timeoutError])
    } catch (error) {
      clearTimeout(timeout)
      if (error instanceof ProviderError) throw error
      if (controller.signal.aborted) throw new ProviderError('BIRDEYE_TIMEOUT', 'Birdeye request timed out')
      throw new ProviderError('BIRDEYE_NETWORK', 'Birdeye is temporarily unavailable')
    }
    try {
      if (response.status === 401 || response.status === 403) {
        blockedError = { code: 'BIRDEYE_ACCESS_DENIED', retryable: false, message: 'Birdeye access is unavailable' }
        throw new ProviderError(blockedError.code, blockedError.message, false)
      }
      if (response.status === 429) {
        cooldownUntil = now() + retryAfterMs(response)
        throw new ProviderError('BIRDEYE_RATE_LIMIT', 'Birdeye rate limit reached', true, true)
      }
      if (!response.ok) throw new ProviderError('BIRDEYE_HTTP_ERROR', 'Birdeye request failed', response.status === 408 || response.status >= 500)
      const text = await readBoundedText(response, controller.signal)
      const body = JSON.parse(text) as unknown
      const root = asRecord(body)
      if (root?.success !== true) throw new ProviderError('BIRDEYE_MALFORMED_RESPONSE', 'Birdeye returned malformed data')
      onSuccess(now())
      return body
    } catch (error) {
      if (controller.signal.aborted) throw new ProviderError('BIRDEYE_TIMEOUT', 'Birdeye request timed out')
      if (error instanceof ProviderError) throw error
      throw new ProviderError('BIRDEYE_MALFORMED_RESPONSE', 'Birdeye returned malformed data')
    } finally {
      clearTimeout(timeout)
    }
  }

  async function withDeadline<T>(work: Promise<T>, deadlineAt: number): Promise<T> {
    const remaining = deadlineAt - now()
    if (remaining <= 0) throw new ProviderError('BIRDEYE_REFRESH_TIMEOUT', 'Birdeye refresh timed out')
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([work, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new ProviderError('BIRDEYE_REFRESH_TIMEOUT', 'Birdeye refresh timed out')), remaining) })])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  type HolderObservation = { walletAddress: string; seed: SeedToken; labels: WalletLabel[] }
  type DiscoveryResult = { observations: HolderObservation[]; malformed: boolean }
  type TradeResult = { activities: WalletActivity[]; malformed: boolean }

  async function discover(seed: SeedToken, deadlineAt: number, onSuccess: (completedAt: number) => void): Promise<DiscoveryResult> {
    const query = new URLSearchParams({ token_address: seed.address, labels: 'smart_trader,kol', sort_by: 'amount', order_type: 'desc', limit: '10' })
    const body = await providerRequest(`/token/v1/holder-positions?${query.toString()}`, deadlineAt, onSuccess)
    const observations: HolderObservation[] = []
    let malformed = false
    for (const row of responseRows(body, 'holders')) {
      const value = asRecord(row)
      if (!value || !validAddress(value.wallet_address)) { malformed = true; continue }
      const labels = normalizeLabels(value.labels)
      if (labels.length === 0) { malformed = true; continue }
      observations.push({ walletAddress: value.wallet_address, seed, labels })
    }
    return { observations, malformed }
  }

  function parseActivities(row: unknown, wallet: Holder, nowMs: number): WalletActivity[] {
    const tx = asRecord(row)
    if (!tx) throw new ProviderError('BIRDEYE_MALFORMED_RESPONSE', 'Birdeye returned malformed trade data')
    if (tx.tx_type !== 'swap') return []
    if (typeof tx.owner !== 'string' || !validAddress(tx.owner)) throw new ProviderError('BIRDEYE_MALFORMED_RESPONSE', 'Birdeye returned malformed trade data')
    if (tx.owner !== wallet.walletAddress) return []
    if (!validSignature(tx.tx_hash)) throw new ProviderError('BIRDEYE_MALFORMED_RESPONSE', 'Birdeye returned malformed trade data')
    const timestamp = finiteNumber(tx.block_unix_time)
    if (timestamp === null) throw new ProviderError('BIRDEYE_MALFORMED_RESPONSE', 'Birdeye returned malformed trade data')
    const observedAt = normalizeIsoSeconds(timestamp, nowMs)
    if (!observedAt) return []
    const legs: Record<string, unknown>[] = []
    let suppliedLeg = false
    let malformedLeg = false
    for (const key of ['base', 'quote']) {
      const raw = tx[key]
      if (raw === undefined || raw === null) continue
      suppliedLeg = true
      if (Array.isArray(raw)) {
        for (const item of raw) {
          const leg = asRecord(item)
          if (leg) legs.push(leg)
          else malformedLeg = true
        }
      } else {
        const leg = asRecord(raw)
        if (leg) legs.push(leg)
        else malformedLeg = true
      }
    }
    if (!suppliedLeg || legs.length === 0 || malformedLeg) throw new ProviderError('BIRDEYE_MALFORMED_RESPONSE', 'Birdeye returned malformed trade data')
    const out: WalletActivity[] = []
    for (const leg of legs) {
      const address = leg.address
      if (!validAddress(address)) throw new ProviderError('BIRDEYE_MALFORMED_RESPONSE', 'Birdeye returned malformed trade data')
      const context = wallet.contexts.get(address)
      if (!context) continue
      const rawAction = typeof leg.type_swap === 'string' ? leg.type_swap.toLowerCase() : ''
      if (rawAction !== 'to' && rawAction !== 'from') throw new ProviderError('BIRDEYE_MALFORMED_RESPONSE', 'Birdeye returned malformed trade data')
      const amount = positiveNumber(leg.ui_amount) ?? (() => {
        const change = finiteNumber(leg.ui_change_amount)
        return change === null || change === 0 ? null : Math.abs(change)
      })()
      if (amount === null || !Number.isFinite(amount) || amount <= 0) throw new ProviderError('BIRDEYE_MALFORMED_RESPONSE', 'Birdeye returned malformed trade data')
      const price = finiteNumber(leg.price)
      const priceUsd = price !== null && price >= 0 ? price : null
      const valueUsd = priceUsd === null ? null : amount * priceUsd
      const index = tx.ins_index === undefined ? '' : String(tx.ins_index)
      const inner = tx.inner_ins_index === undefined ? '' : String(tx.inner_ins_index)
      const action = rawAction === 'to' ? 'buy' : 'sell'
      out.push({ id: `${tx.tx_hash}:${index}:${inner}:${address}:${action}`, walletAddress: wallet.walletAddress, walletLabels: context.labels, classificationToken: context.seed, action, tokenAddress: address, tokenSymbol: context.seed.symbol, amount, priceUsd, valueUsd: valueUsd !== null && Number.isFinite(valueUsd) ? valueUsd : null, signature: tx.tx_hash, observedAt })
    }
    return out
  }

  async function tradeHistory(wallet: Holder, nowMs: number, deadlineAt: number, onSuccess: (completedAt: number) => void): Promise<TradeResult> {
    const after = Math.floor(nowMs / 1000) - LOOKBACK_SECONDS
    const query = new URLSearchParams({ address: wallet.walletAddress, tx_type: 'swap', after_time: String(after), limit: '20' })
    const body = await providerRequest(`/trader/txs/seek_by_time?${query.toString()}`, deadlineAt, onSuccess)
    const activities: WalletActivity[] = []
    let malformed = false
    for (const row of responseRows(body, 'trades')) {
      try { activities.push(...parseActivities(row, wallet, now())) }
      catch (error) {
        if (error instanceof ProviderError) malformed = true
        else throw error
      }
    }
    return { activities, malformed }
  }

  function chooseWallets(observations: Array<{ walletAddress: string; seed: SeedToken; labels: WalletLabel[] }>): Holder[] {
    const byWallet = new Map<string, Holder>()
    for (const observation of observations) {
      let holder = byWallet.get(observation.walletAddress)
      if (!holder) { holder = { walletAddress: observation.walletAddress, contexts: new Map() }; byWallet.set(observation.walletAddress, holder) }
      const previous = holder.contexts.get(observation.seed.address)
      holder.contexts.set(observation.seed.address, { seed: observation.seed, labels: previous ? mergeLabels(previous.labels, observation.labels) : observation.labels })
    }
    const holders = [...byWallet.values()]
    const hasLabel = (holder: Holder, label: WalletLabel) => [...holder.contexts.values()].some((context) => context.labels.includes(label))
    const selected: Holder[] = []
    for (const label of ['kol', 'smart_trader'] as WalletLabel[]) {
      const candidate = holders.find((holder) => !selected.includes(holder) && hasLabel(holder, label))
      if (candidate) selected.push(candidate)
    }
    for (const holder of holders) { if (selected.length >= MAX_WALLETS) break; if (!selected.includes(holder)) selected.push(holder) }
    return selected.slice(0, MAX_WALLETS)
  }

  function unavailable(tokens: SeedToken[], error: InternalError, nowMs: number, staleResult?: { result: WalletActivityResult; storedAt: number } | null): WalletActivityResult {
    if (staleResult && nowMs - staleResult.storedAt <= maxStaleMs) return withError({ ...staleResult.result, status: 'stale', stale: true, partial: true, nextRefreshAt: new Date(nowMs).toISOString() }, error)
    return withError({ chain: 'solana', source: 'birdeye', status: 'unavailable', activities: [], coverage: { tokens, walletCount: 0, limited: true, lookbackDays: LOOKBACK_DAYS }, fetchedAt: null, nextRefreshAt: null, stale: false, partial: false }, error)
  }

  async function refresh(): Promise<WalletActivityResult> {
    const startedAt = now()
    const deadlineAt = startedAt + refreshDeadlineMs
    if (!options.apiKey?.trim()) return unavailable([], { code: 'BIRDEYE_NOT_CONFIGURED', retryable: false, message: 'Birdeye is not configured' }, startedAt, null)
    if (blockedError) return unavailable(cached?.result.coverage.tokens ?? [], blockedError, startedAt, newestUsableSnapshot())
    if (startedAt < cooldownUntil) return unavailable(cached?.result.coverage.tokens ?? [], { code: 'BIRDEYE_COOLDOWN', retryable: true, message: 'Birdeye rate limit cooldown is active' }, startedAt, newestUsableSnapshot())
    let snapshot: SeedTokenSnapshot
    try { snapshot = await withDeadline(Promise.resolve(options.getSeedTokens()), deadlineAt) }
    catch (error) { return unavailable([], errorFrom(error), now(), newestUsableSnapshot()) }
    if (!snapshot || !Array.isArray(snapshot.tokens)) return unavailable([], { code: 'SEEDS_UNAVAILABLE', retryable: true, message: 'Seed tokens are unavailable' }, now(), newestUsableSnapshot())
    const seeds = dedupeSeeds(snapshot)
    if (seeds.length === 0) return unavailable([], { code: 'SEEDS_UNAVAILABLE', retryable: true, message: 'Seed tokens are unavailable' }, now(), newestUsableSnapshot())
    const seedState = seedTimestampState(snapshot.fetchedAt, startedAt)
    if (!seedState) return unavailable([], { code: 'SEEDS_UNAVAILABLE', retryable: true, message: 'Seed tokens are unavailable' }, now(), newestUsableSnapshot())
    const seedStale = snapshot.stale || seedState === 'stale'
    let fetchedAtMs: number | null = null
    const onSuccess = (completedAt: number) => { fetchedAtMs = completedAt }
    const discoveryErrors: InternalError[] = []
    const observations: Array<{ walletAddress: string; seed: SeedToken; labels: WalletLabel[] }> = []
    for (const seed of seeds) {
      try {
        const discovery = await discover(seed, deadlineAt, onSuccess)
        observations.push(...discovery.observations)
        if (discovery.malformed) discoveryErrors.push({ code: 'BIRDEYE_MALFORMED_RESPONSE', retryable: true, message: 'Birdeye returned malformed holder data' })
      }
      catch (error) { discoveryErrors.push(errorFrom(error)) }
    }
    const wallets = chooseWallets(observations)
    const activities: WalletActivity[] = []
    const tradeErrors: InternalError[] = []
    let failedHistoryCalls = 0
    for (const wallet of wallets) {
      try {
        const history = await tradeHistory(wallet, startedAt, deadlineAt, onSuccess)
        activities.push(...history.activities)
        if (history.malformed) {
          tradeErrors.push({ code: 'BIRDEYE_MALFORMED_RESPONSE', retryable: true, message: 'Birdeye returned malformed trade data' })
          if (history.activities.length === 0) failedHistoryCalls += 1
        }
      }
      catch (error) { failedHistoryCalls += 1; tradeErrors.push(errorFrom(error)) }
    }
    const deduped = [...new Map(activities.map((item) => [item.id, item])).values()].sort((a, b) => b.observedAt.localeCompare(a.observedAt) || a.id.localeCompare(b.id)).slice(0, MAX_ACTIVITIES)
    const errors = [...discoveryErrors, ...tradeErrors]
    const allHistoryFailed = wallets.length > 0 && failedHistoryCalls === wallets.length
    if (allHistoryFailed || (wallets.length === 0 && observations.length === 0 && discoveryErrors.length === seeds.length)) return unavailable(seeds, errors[0] ?? { code: 'BIRDEYE_UNAVAILABLE', retryable: true, message: 'Birdeye is temporarily unavailable' }, now(), newestUsableSnapshot())
    const partial = errors.length > 0
    const completionAt = fetchedAtMs ?? now()
    const old = newestUsableSnapshot()
    if (partial && deduped.length === 0 && old && startedAt - old.storedAt <= maxStaleMs) {
      const fallback: WalletActivityResult = { ...old.result, status: 'stale', partial: true, stale: true, nextRefreshAt: old.result.nextRefreshAt, error: errors[0] ? { ...errors[0], message: sanitizedMessage(errors[0]) } : undefined }
      cached = { result: fallback, storedAt: old.storedAt }
      return fallback
    }
    const result: WalletActivityResult = { chain: 'solana', source: 'birdeye', status: seedStale ? 'stale' : partial ? 'partial' : 'ready', activities: deduped, coverage: { tokens: seeds, walletCount: wallets.length, limited: true, lookbackDays: LOOKBACK_DAYS }, fetchedAt: new Date(completionAt).toISOString(), nextRefreshAt: new Date(completionAt + cacheTtlMs).toISOString(), stale: seedStale, partial }
    if (errors[0]) result.error = { ...errors[0], message: sanitizedMessage(errors[0]) }
    if (!partial) { cached = { result, storedAt: completionAt }; lastGood = { result, storedAt: completionAt } }
    else if (deduped.length > 0) cached = { result, storedAt: completionAt }
    return result
  }

  return {
    getActivity: async () => {
      const nowMs = now()
      if (failureCache && nowMs < failureCache.retryAt) {
        if (failureCache.result.fetchedAt && nowMs - Date.parse(failureCache.result.fetchedAt) > maxStaleMs) {
          const expired = unavailable(failureCache.result.coverage.tokens, failureCache.result.error ?? { code: 'BIRDEYE_UNAVAILABLE', retryable: true, message: 'Birdeye is temporarily unavailable' }, nowMs, null)
          failureCache = { result: expired, retryAt: failureCache.retryAt }
          return expired
        }
        return failureCache.result
      }
      if (cached && nowMs - cached.storedAt < cacheTtlMs) return cached.result
      if (inFlight) return inFlight
      if (blockedError) return unavailable(cached?.result.coverage.tokens ?? [], blockedError, nowMs, newestUsableSnapshot())
      if (nowMs < cooldownUntil) return unavailable(cached?.result.coverage.tokens ?? [], { code: 'BIRDEYE_COOLDOWN', retryable: true, message: 'Birdeye rate limit cooldown is active' }, nowMs, newestUsableSnapshot())
      inFlight = refresh().then((result) => {
        if (result.status === 'unavailable' || (result.status === 'stale' && result.error) || (result.status === 'partial' && result.error && result.fetchedAt === lastGood?.result.fetchedAt)) {
          const retryAt = result.error?.code === 'BIRDEYE_RATE_LIMIT'
            ? cooldownUntil
            : Math.max(now() + cooldownMs, cooldownUntil)
          result = { ...result, nextRefreshAt: result.error?.retryable ? new Date(retryAt).toISOString() : null }
          failureCache = { result, retryAt }
        } else {
          failureCache = null
        }
        return result
      }).finally(() => { inFlight = null })
      return inFlight
    },
  }
}

export type { SeedToken, SeedTokenSnapshot, WalletActivity, WalletActivityResult, WalletActivityService }
