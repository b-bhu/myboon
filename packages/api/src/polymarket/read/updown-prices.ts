export type UpDownAsset = 'btc' | 'eth'
export type UpDownDuration = 'hourly' | 'daily'

export interface UpDownRoundIdentity {
  slug: string
  asset: UpDownAsset
  duration: UpDownDuration
  startDate: string
  endDate: string
}

export interface UpDownReferencePrice {
  value: number
  source: 'binance'
  symbol: 'BTCUSDT' | 'ETHUSDT'
  interval: '1m' | '1h'
  valueType: 'open' | 'close'
  boundaryTime: string
  observedAt: string
}

export interface UpDownCurrentPrice {
  value: number
  source: 'polymarket_rtds_binance' | 'binance_rest'
  symbol: 'BTCUSDT' | 'ETHUSDT'
  observedAt: string
}

export interface UpDownPricePoint {
  t: number
  p: number
}

export interface UpDownPriceHistory {
  source: 'binance'
  symbol: 'BTCUSDT' | 'ETHUSDT'
  interval: '1m' | '5m'
  points: UpDownPricePoint[]
}

export interface UpDownReferencePriceStore {
  get(roundSlug: string): Promise<UpDownReferencePrice | null>
  upsert(round: UpDownRoundIdentity, price: UpDownReferencePrice): Promise<void>
}

type FetchLike = typeof fetch

interface ReferencePriceRow {
  round_slug: string
  asset: UpDownAsset
  duration: UpDownDuration
  boundary_time: string
  price: number | string
  source: 'binance'
  source_symbol: 'BTCUSDT' | 'ETHUSDT'
  source_interval: '1m' | '1h'
  source_value_type: 'open' | 'close'
  observed_at: string
}

export class SupabaseUpDownReferencePriceStore implements UpDownReferencePriceStore {
  private readonly restBaseUrl: string

  constructor(
    supabaseUrl: string,
    private readonly serviceRoleKey: string,
    private readonly fetchImpl: FetchLike = globalThis.fetch,
  ) {
    this.restBaseUrl = `${supabaseUrl.replace(/\/$/, '')}/rest/v1`
  }

  async get(roundSlug: string): Promise<UpDownReferencePrice | null> {
    const params = new URLSearchParams({
      select: 'round_slug,asset,duration,boundary_time,price,source,source_symbol,source_interval,source_value_type,observed_at',
      round_slug: `eq.${roundSlug}`,
      limit: '1',
    })
    const res = await this.fetchImpl(
      `${this.restBaseUrl}/polymarket_updown_reference_prices?${params.toString()}`,
      { headers: this.headers(), signal: AbortSignal.timeout(10_000) },
    )
    if (!res.ok) throw new Error(`Supabase Up/Down reference read failed: ${res.status}`)
    const rows = await res.json() as ReferencePriceRow[]
    const row = rows[0]
    if (!row) return null

    const value = Number(row.price)
    if (!Number.isFinite(value) || value <= 0) return null
    return {
      value,
      source: row.source,
      symbol: row.source_symbol,
      interval: row.source_interval,
      valueType: row.source_value_type,
      boundaryTime: row.boundary_time,
      observedAt: row.observed_at,
    }
  }

  async upsert(round: UpDownRoundIdentity, price: UpDownReferencePrice): Promise<void> {
    const res = await this.fetchImpl(
      `${this.restBaseUrl}/polymarket_updown_reference_prices?on_conflict=round_slug`,
      {
        method: 'POST',
        headers: {
          ...this.headers(),
          Prefer: 'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify({
          round_slug: round.slug,
          asset: round.asset,
          duration: round.duration,
          boundary_time: price.boundaryTime,
          price: price.value,
          source: price.source,
          source_symbol: price.symbol,
          source_interval: price.interval,
          source_value_type: price.valueType,
          observed_at: price.observedAt,
          updated_at: new Date().toISOString(),
        }),
        signal: AbortSignal.timeout(10_000),
      },
    )
    if (!res.ok) throw new Error(`Supabase Up/Down reference upsert failed: ${res.status}`)
  }

  private headers(): Record<string, string> {
    return {
      apikey: this.serviceRoleKey,
      Authorization: `Bearer ${this.serviceRoleKey}`,
      'Content-Type': 'application/json',
    }
  }
}

interface RtdsPriceMessage {
  asset: UpDownAsset
  value: number
  observedAt: string
}

export function parseRtdsCryptoPriceMessage(input: unknown): RtdsPriceMessage | null {
  const text = typeof input === 'string'
    ? input
    : input instanceof Buffer
      ? input.toString('utf8')
      : null
  if (!text || text === 'PONG') return null

  try {
    const message = JSON.parse(text) as Record<string, unknown>
    if (message.topic !== 'crypto_prices' || message.type !== 'update') return null
    if (!message.payload || typeof message.payload !== 'object') return null
    const payload = message.payload as Record<string, unknown>
    const symbol = String(payload.symbol ?? '').toLowerCase()
    const asset = symbol === 'btcusdt' ? 'btc' : symbol === 'ethusdt' ? 'eth' : null
    const value = Number(payload.value)
    const timestamp = Number(payload.timestamp ?? message.timestamp)
    if (!asset || !Number.isFinite(value) || value <= 0 || !Number.isFinite(timestamp)) return null
    return { asset, value, observedAt: new Date(timestamp).toISOString() }
  } catch {
    return null
  }
}

const RTDS_URL = 'wss://ws-live-data.polymarket.com'
const RTDS_HEARTBEAT_MS = 5_000
const RTDS_RECONNECT_MS = 2_000
const MAX_RTDS_PRICE_AGE_MS = 20_000

export class PolymarketRtdsPriceFeed {
  private readonly prices = new Map<UpDownAsset, UpDownCurrentPrice>()
  private socket: WebSocket | null = null
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private reconnect: ReturnType<typeof setTimeout> | null = null
  private started = false

  start(): void {
    if (this.started) return
    this.started = true
    this.connect()
  }

  stop(): void {
    this.started = false
    if (this.heartbeat) clearInterval(this.heartbeat)
    if (this.reconnect) clearTimeout(this.reconnect)
    this.heartbeat = null
    this.reconnect = null
    const socket = this.socket
    this.socket = null
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      socket.close()
    }
  }

  get(asset: UpDownAsset, now = Date.now()): UpDownCurrentPrice | null {
    const price = this.prices.get(asset)
    if (!price || now - Date.parse(price.observedAt) > MAX_RTDS_PRICE_AGE_MS) return null
    return price
  }

  ingest(input: unknown): void {
    const parsed = parseRtdsCryptoPriceMessage(input)
    if (!parsed) return
    this.prices.set(parsed.asset, {
      value: parsed.value,
      source: 'polymarket_rtds_binance',
      symbol: symbolForAsset(parsed.asset),
      observedAt: parsed.observedAt,
    })
  }

  private connect(): void {
    if (!this.started || this.socket) return
    try {
      const socket = new WebSocket(RTDS_URL)
      this.socket = socket
      socket.onopen = () => {
        socket.send(JSON.stringify({
          action: 'subscribe',
          subscriptions: [{
            topic: 'crypto_prices',
            type: 'update',
            filters: 'btcusdt,ethusdt',
          }],
        }))
        this.heartbeat = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) socket.send('PING')
        }, RTDS_HEARTBEAT_MS)
      }
      socket.onmessage = (event: MessageEvent) => this.ingest(event.data)
      socket.onerror = () => socket.close()
      socket.onclose = () => {
        if (this.heartbeat) clearInterval(this.heartbeat)
        this.heartbeat = null
        if (this.socket === socket) this.socket = null
        if (this.started && !this.reconnect) {
          this.reconnect = setTimeout(() => {
            this.reconnect = null
            this.connect()
          }, RTDS_RECONNECT_MS)
        }
      }
    } catch {
      this.socket = null
      if (this.started && !this.reconnect) {
        this.reconnect = setTimeout(() => {
          this.reconnect = null
          this.connect()
        }, RTDS_RECONNECT_MS)
      }
    }
  }
}

export const upDownLivePriceFeed = new PolymarketRtdsPriceFeed()

export class UpDownPriceService {
  private readonly referenceCache = new Map<string, UpDownReferencePrice>()
  private storeWarningLogged = false

  constructor(
    private readonly store?: UpDownReferencePriceStore,
    private readonly fetchImpl: FetchLike = globalThis.fetch,
    private readonly liveFeed: Pick<PolymarketRtdsPriceFeed, 'get'> = upDownLivePriceFeed,
  ) {}

  async getReferencePrice(round: UpDownRoundIdentity): Promise<UpDownReferencePrice | null> {
    const cached = this.referenceCache.get(round.slug)
    if (cached) return cached

    if (this.store) {
      try {
        const stored = await this.store.get(round.slug)
        if (stored) {
          this.referenceCache.set(round.slug, stored)
          return stored
        }
      } catch (error) {
        this.warnStoreOnce(error)
      }
    }

    const fetched = await this.fetchReferencePrice(round)
    if (!fetched) return null
    this.referenceCache.set(round.slug, fetched)
    if (this.store) {
      try {
        await this.store.upsert(round, fetched)
      } catch (error) {
        this.warnStoreOnce(error)
      }
    }
    return fetched
  }

  async getCurrentPrice(asset: UpDownAsset): Promise<UpDownCurrentPrice | null> {
    const live = this.liveFeed.get(asset)
    if (live) return live

    const symbol = symbolForAsset(asset)
    try {
      const res = await this.fetchImpl(
        `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`,
        { signal: AbortSignal.timeout(5_000) },
      )
      if (!res.ok) return null
      const body = await res.json() as Record<string, unknown>
      const value = Number(body.price)
      if (!Number.isFinite(value) || value <= 0) return null
      return {
        value,
        source: 'binance_rest',
        symbol,
        observedAt: new Date().toISOString(),
      }
    } catch {
      return null
    }
  }

  async getHistory(round: UpDownRoundIdentity, now = Date.now()): Promise<UpDownPriceHistory> {
    const start = Date.parse(round.startDate)
    const end = Math.min(Date.parse(round.endDate), now)
    const interval = round.duration === 'hourly' ? '1m' : '5m'
    const tailMs = round.duration === 'hourly' ? 15 * 60_000 : 4 * 60 * 60_000
    const params = new URLSearchParams({
      symbol: symbolForAsset(round.asset),
      interval,
      startTime: String(start - tailMs),
      endTime: String(end),
      limit: '1000',
    })
    const res = await this.fetchImpl(`https://api.binance.com/api/v3/klines?${params}`, {
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(`Binance price history failed: ${res.status}`)
    const rows = await res.json() as unknown[]
    const points = Array.isArray(rows) ? rows.flatMap(mapKlinePoint) : []

    const live = await this.getCurrentPrice(round.asset)
    if (live && Date.parse(live.observedAt) <= Date.parse(round.endDate)) {
      const last = points.at(-1)
      const observedAt = Date.parse(live.observedAt)
      if (!last || observedAt > last.t) points.push({ t: observedAt, p: live.value })
    }
    return {
      source: 'binance',
      symbol: symbolForAsset(round.asset),
      interval,
      points,
    }
  }

  private async fetchReferencePrice(round: UpDownRoundIdentity): Promise<UpDownReferencePrice | null> {
    const boundaryMs = Date.parse(round.startDate)
    if (!Number.isFinite(boundaryMs)) return null
    const interval = round.duration === 'hourly' ? '1h' : '1m'
    const valueType = round.duration === 'hourly' ? 'open' : 'close'
    const params = new URLSearchParams({
      symbol: symbolForAsset(round.asset),
      interval,
      startTime: String(boundaryMs),
      limit: '1',
    })
    try {
      const res = await this.fetchImpl(`https://api.binance.com/api/v3/klines?${params}`, {
        signal: AbortSignal.timeout(5_000),
      })
      if (!res.ok) return null
      const rows = await res.json() as unknown[]
      const row = Array.isArray(rows) && Array.isArray(rows[0]) ? rows[0] : null
      if (!row || Number(row[0]) !== boundaryMs) return null
      const value = Number(row[valueType === 'open' ? 1 : 4])
      const closeTime = Number(row[6])
      if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(closeTime)) return null
      if (valueType === 'close' && Date.now() <= closeTime) return null
      return {
        value,
        source: 'binance',
        symbol: symbolForAsset(round.asset),
        interval,
        valueType,
        boundaryTime: round.startDate,
        observedAt: new Date(valueType === 'close' ? closeTime : Date.now()).toISOString(),
      }
    } catch {
      return null
    }
  }

  private warnStoreOnce(error: unknown): void {
    if (this.storeWarningLogged) return
    this.storeWarningLogged = true
    console.warn('[api] Up/Down reference persistence unavailable; using Binance + memory cache:', error instanceof Error ? error.message : error)
  }
}

function symbolForAsset(asset: UpDownAsset): 'BTCUSDT' | 'ETHUSDT' {
  return asset === 'btc' ? 'BTCUSDT' : 'ETHUSDT'
}

function mapKlinePoint(row: unknown): UpDownPricePoint[] {
  if (!Array.isArray(row)) return []
  const t = Number(row[6])
  const p = Number(row[4])
  return Number.isFinite(t) && Number.isFinite(p) && p > 0 ? [{ t, p }] : []
}
