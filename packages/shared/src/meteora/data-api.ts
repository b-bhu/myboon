import Decimal from 'decimal.js'
import { METEORA_CACHE_POLICY, METEORA_DATA_API_URL, METEORA_MAX_PAGE_SIZE } from './config.js'
import { assertSolanaAddress } from './data-validation.js'
import { MeteoraClientError } from './errors.js'
import type {
  MeteoraClientConfig,
  MeteoraFreshness,
  MeteoraLimitOrderPool,
  MeteoraLimitOrderSummary,
  MeteoraOhlcvQuery,
  MeteoraOhlcvSeries,
  MeteoraPage,
  MeteoraPoolDetail,
  MeteoraPoolQuery,
  MeteoraPoolSummary,
  MeteoraProtocolMetrics,
  MeteoraPortfolio,
  MeteoraPortfolioQuery,
  MeteoraPosition,
  MeteoraPositionEvent,
  MeteoraPositionQuery,
  MeteoraResult,
  MeteoraTokenRef,
  MeteoraTokenSummary,
} from './types.js'

interface CachePolicy {
  freshMs: number
  staleMs: number
}

interface CacheEntry {
  value: unknown
  fetchedAt: number
  expiresAt: number
  staleUntil: number
}

interface RawPage<T> {
  total: number
  pages: number
  current_page: number
  page_size: number
  data: T[]
}

interface RawToken {
  address?: string
  symbol?: string
  name?: string
  decimals?: number
  icon?: string
  is_verified?: boolean
}

interface RawPool {
  address: string
  name: string
  token_x: RawToken
  token_y: RawToken
  reserve_x: string
  reserve_y: string
  token_x_amount: number
  token_y_amount: number
  created_at: number
  reward_mint_x: string
  reward_mint_y: string
  pool_config: {
    bin_step: number
    base_fee_pct: number
    max_fee_pct: number
    protocol_fee_pct: number
    collect_fee_mode: number
  }
  dynamic_fee_pct: number
  tvl: number
  current_price: number
  apr: number
  apy: number
  has_farm: boolean
  volume?: Record<string, number>
  fees?: Record<string, number>
  fee_tvl_ratio?: Record<string, number>
  is_blacklisted: boolean
  tags?: string[]
}

interface RawOhlcv {
  timeframe?: string | null
  start_time: number
  end_time: number
  data: Array<{
    timestamp: number
    timestamp_str: string
    open: number
    high: number
    low: number
    close: number
    volume: number
  }>
}

interface RawProtocolMetrics {
  total_tvl: number
  volume_24h: number
  fee_24h: number
  total_volume: number
  total_fees: number
  total_pools: number
}

interface RawPortfolio {
  page: number
  pageSize: number
  hasNext: boolean
  totalCount: number
  totalPositions: number
  solPrice?: string | null
  total?: Record<string, unknown> | null
  pools: Array<Record<string, unknown>>
}

interface RawPositions {
  totalCount: number
  page: number
  pageSize: number
  hasNext: boolean
  positions: Array<Record<string, unknown>>
}

interface RawPositionHistory {
  events: Array<Record<string, unknown>>
}

interface RawLimitOrderSummary {
  open_orders: number
  closed_orders: number
  total_deposit_usd: string
  total_deposit_sol: string
  total_bonus_usd: string
  total_bonus_sol: string
}

const numberString = (value: unknown): string | null => {
  if (value === null || value === undefined || value === '') return null
  try {
    return new Decimal(value as Decimal.Value).toString()
  } catch {
    return null
  }
}

const stringValue = (record: Record<string, unknown>, key: string, fallback = ''): string => {
  const value = record[key]
  return typeof value === 'string' ? value : fallback
}

const nullableString = (record: Record<string, unknown>, key: string): string | null => {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

const numberValue = (record: Record<string, unknown>, key: string, fallback = 0): number => {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

const booleanValue = (record: Record<string, unknown>, key: string): boolean | null => {
  const value = record[key]
  return typeof value === 'boolean' ? value : null
}

function normalizeToken(raw: RawToken, fallbackSymbol = ''): MeteoraTokenSummary {
  return {
    address: raw.address ?? '',
    symbol: raw.symbol ?? fallbackSymbol,
    name: raw.name ?? raw.symbol ?? fallbackSymbol,
    decimals: Number.isInteger(raw.decimals) ? raw.decimals! : 0,
    iconUrl: raw.icon || null,
    verified: raw.is_verified === true,
  }
}

function normalizePortfolioToken(
  record: Record<string, unknown>,
  side: 'X' | 'Y',
): MeteoraTokenRef {
  // The portfolio endpoint doesn't return decimals or verified status —
  // decimals: 0 / verified: true here used to be a fabrication, not a real
  // answer. null is the honest value for an unknown the upstream API never
  // sends. See docs/modules/wallet/PRDs/2026_08_11_token_identity_and_venue_adapters_PRD.md.
  return {
    address: stringValue(record, `token${side}Mint`),
    symbol: stringValue(record, `token${side}`),
    name: stringValue(record, `token${side}`),
    decimals: null,
    iconUrl: nullableString(record, `token${side}Icon`),
    verified: null,
  }
}

function normalizePool(raw: RawPool): MeteoraPoolDetail {
  const tokenX = normalizeToken(raw.token_x)
  const tokenY = normalizeToken(raw.token_y)
  const approvedByMeteora = !raw.is_blacklisted && tokenX.verified && tokenY.verified

  return {
    address: raw.address,
    pair: `${tokenX.symbol} / ${tokenY.symbol}`,
    tokenX,
    tokenY,
    currentPrice: numberString(raw.current_price),
    tvlUsd: numberString(raw.tvl),
    volume24hUsd: numberString(raw.volume?.['24h']),
    fees24hUsd: numberString(raw.fees?.['24h']),
    feeTvl24hPct: numberString(raw.fee_tvl_ratio?.['24h']),
    baseFeePct: numberString(raw.pool_config?.base_fee_pct),
    dynamicFeePct: numberString(raw.dynamic_fee_pct),
    apr24hPct: numberString(raw.apr),
    apy24hPct: numberString(raw.apy),
    binStep: raw.pool_config?.bin_step ?? 0,
    hasFarm: raw.has_farm === true,
    tags: raw.tags ?? [],
    approvedByMeteora,
    reserveX: raw.reserve_x,
    reserveY: raw.reserve_y,
    tokenXAmount: numberString(raw.token_x_amount),
    tokenYAmount: numberString(raw.token_y_amount),
    maxFeePct: numberString(raw.pool_config?.max_fee_pct),
    protocolFeePct: numberString(raw.pool_config?.protocol_fee_pct),
    collectFeeMode: raw.pool_config?.collect_fee_mode ?? 0,
    rewardMintX: raw.reward_mint_x || null,
    rewardMintY: raw.reward_mint_y || null,
    createdAt: raw.created_at ? new Date(raw.created_at).toISOString() : null,
  }
}

function toPoolSummary(pool: MeteoraPoolDetail): MeteoraPoolSummary {
  const {
    reserveX: _reserveX,
    reserveY: _reserveY,
    tokenXAmount: _tokenXAmount,
    tokenYAmount: _tokenYAmount,
    maxFeePct: _maxFeePct,
    protocolFeePct: _protocolFeePct,
    collectFeeMode: _collectFeeMode,
    rewardMintX: _rewardMintX,
    rewardMintY: _rewardMintY,
    createdAt: _createdAt,
    ...summary
  } = pool
  return summary
}

export class MeteoraDataApiClient {
  private readonly baseUrl: string
  private readonly fetcher: typeof fetch
  private readonly timeoutMs: number
  private readonly maxRetries: number
  private readonly cache = new Map<string, CacheEntry>()
  private readonly inFlight = new Map<string, Promise<unknown>>()

  constructor(config: MeteoraClientConfig = {}) {
    this.baseUrl = (config.dataApiUrl ?? METEORA_DATA_API_URL).replace(/\/+$/, '')
    this.fetcher = config.fetch ?? fetch
    this.timeoutMs = config.requestTimeoutMs ?? 12_000
    this.maxRetries = config.maxRetries ?? 2
  }

  clearCache(): void {
    this.cache.clear()
  }

  async listPools(query: MeteoraPoolQuery = {}): Promise<MeteoraResult<MeteoraPage<MeteoraPoolSummary>>> {
    const page = Math.max(1, query.page ?? 1)
    const pageSize = Math.min(METEORA_MAX_PAGE_SIZE.pools, Math.max(1, query.pageSize ?? 20))
    const filters = ['is_blacklisted=false']
    if (query.minTvlUsd) filters.push(`tvl>=${query.minTvlUsd}`)

    const result = await this.request<RawPage<RawPool>>(
      '/pools',
      {
        page,
        page_size: pageSize,
        query: query.query,
        sort_by: query.sortBy ?? 'volume_24h:desc',
        filter_by: filters.join(' && '),
      },
      METEORA_CACHE_POLICY.pools,
    )

    const items = result.data.data
      .map(normalizePool)
      .filter((pool) => query.includeUnverified || pool.approvedByMeteora)
      .map(toPoolSummary)

    return {
      data: {
        items,
        page: result.data.current_page,
        pageSize: result.data.page_size,
        total: result.data.total,
        totalPages: result.data.pages,
        hasNext: result.data.current_page < result.data.pages,
      },
      freshness: result.freshness,
    }
  }

  async getProtocolMetrics(): Promise<MeteoraResult<MeteoraProtocolMetrics>> {
    const result = await this.request<RawProtocolMetrics>(
      '/stats/protocol_metrics',
      {},
      METEORA_CACHE_POLICY.protocolMetrics,
    )

    return {
      data: {
        totalTvlUsd: numberString(result.data.total_tvl) ?? '0',
        volume24hUsd: numberString(result.data.volume_24h) ?? '0',
        fees24hUsd: numberString(result.data.fee_24h) ?? '0',
        totalVolumeUsd: numberString(result.data.total_volume) ?? '0',
        totalFeesUsd: numberString(result.data.total_fees) ?? '0',
        totalPools: Number.isFinite(result.data.total_pools) ? result.data.total_pools : 0,
      },
      freshness: result.freshness,
    }
  }

  async getPool(poolAddress: string): Promise<MeteoraResult<MeteoraPoolDetail>> {
    assertSolanaAddress(poolAddress, 'poolAddress')
    const result = await this.request<RawPool>(
      `/pools/${encodeURIComponent(poolAddress)}`,
      {},
      METEORA_CACHE_POLICY.pool,
    )
    const pool = normalizePool(result.data)
    if (!pool.approvedByMeteora) {
      throw new MeteoraClientError('POOL_NOT_APPROVED', 'This pool is not an approved Meteora pool')
    }
    return { data: pool, freshness: result.freshness }
  }

  async getOhlcv(
    poolAddress: string,
    query: MeteoraOhlcvQuery = {},
  ): Promise<MeteoraResult<MeteoraOhlcvSeries>> {
    assertSolanaAddress(poolAddress, 'poolAddress')
    const result = await this.request<RawOhlcv>(
      `/pools/${encodeURIComponent(poolAddress)}/ohlcv`,
      {
        timeframe: query.timeframe ?? '1h',
        start_time: query.startTime,
        end_time: query.endTime,
      },
      METEORA_CACHE_POLICY.ohlcv,
    )

    return {
      data: {
        timeframe: result.data.timeframe ?? null,
        startTime: result.data.start_time,
        endTime: result.data.end_time,
        candles: result.data.data.map((candle) => ({
          timestamp: candle.timestamp,
          timestampIso: candle.timestamp_str,
          open: numberString(candle.open) ?? '0',
          high: numberString(candle.high) ?? '0',
          low: numberString(candle.low) ?? '0',
          close: numberString(candle.close) ?? '0',
          volume: numberString(candle.volume) ?? '0',
        })),
      },
      freshness: result.freshness,
    }
  }

  async getOpenPortfolio(
    walletAddress: string,
    query: MeteoraPortfolioQuery = {},
  ): Promise<MeteoraResult<MeteoraPortfolio>> {
    assertSolanaAddress(walletAddress, 'walletAddress')
    const result = await this.request<RawPortfolio>(
      '/portfolio/open',
      {
        user: walletAddress,
        page: Math.max(1, query.page ?? 1),
        page_size: Math.min(METEORA_MAX_PAGE_SIZE.portfolio, Math.max(1, query.pageSize ?? 20)),
        sort_by: query.sortBy ?? 'current_balances',
        sort_direction: query.sortDirection ?? 'desc',
      },
      METEORA_CACHE_POLICY.portfolio,
    )

    const total = result.data.total ?? {}
    const pools = result.data.pools.map((record) => {
      const tokenX = normalizePortfolioToken(record, 'X')
      const tokenY = normalizePortfolioToken(record, 'Y')
      return {
        poolAddress: stringValue(record, 'poolAddress'),
        pair: `${tokenX.symbol} / ${tokenY.symbol}`,
        tokenX,
        tokenY,
        binStep: numberValue(record, 'binStep'),
        baseFeePct: numberString(record.baseFee) ?? '0',
        currentPrice: numberString(record.poolPrice),
        balanceUsd: stringValue(record, 'balances', '0'),
        balanceSol: nullableString(record, 'balancesSol'),
        unclaimedFeesUsd: stringValue(record, 'unclaimedFees', '0'),
        unclaimedFeesSol: nullableString(record, 'unclaimedFeesSol'),
        pnlUsd: stringValue(record, 'pnl', '0'),
        pnlPct: stringValue(record, 'pnlPctChange', '0'),
        totalDepositUsd: stringValue(record, 'totalDeposit', '0'),
        openPositionCount: numberValue(record, 'openPositionCount'),
        positionAddresses: Array.isArray(record.listPositions)
          ? record.listPositions.filter((value): value is string => typeof value === 'string')
          : [],
        outOfRangePositionAddresses: Array.isArray(record.positionsOutOfRange)
          ? record.positionsOutOfRange.filter((value): value is string => typeof value === 'string')
          : [],
        outOfRange: booleanValue(record, 'outOfRange'),
      }
    })

    return {
      data: {
        pools,
        page: result.data.page,
        pageSize: result.data.pageSize,
        totalPools: result.data.totalCount,
        totalPositions: result.data.totalPositions,
        hasNext: result.data.hasNext,
        totalBalanceUsd: numberString(total.currentBalances ?? total.balances),
        totalUnclaimedFeesUsd: numberString(total.unclaimedFees),
        totalPnlUsd: numberString(total.pnl),
        solPriceUsd: result.data.solPrice ?? null,
      },
      freshness: result.freshness,
    }
  }

  async getPositions(
    poolAddress: string,
    walletAddress: string,
    query: MeteoraPositionQuery = {},
  ): Promise<MeteoraResult<MeteoraPage<MeteoraPosition>>> {
    assertSolanaAddress(poolAddress, 'poolAddress')
    assertSolanaAddress(walletAddress, 'walletAddress')
    const result = await this.request<RawPositions>(
      `/positions/${encodeURIComponent(poolAddress)}/pnl`,
      {
        user: walletAddress,
        status: query.status ?? 'all',
        page: Math.max(1, query.page ?? 1),
        page_size: Math.min(METEORA_MAX_PAGE_SIZE.positions, Math.max(1, query.pageSize ?? 20)),
      },
      METEORA_CACHE_POLICY.positions,
    )

    const items = result.data.positions.map((record) => ({
      address: stringValue(record, 'positionAddress'),
      minPrice: stringValue(record, 'minPrice', '0'),
      maxPrice: stringValue(record, 'maxPrice', '0'),
      lowerBinId: numberValue(record, 'lowerBinId'),
      upperBinId: numberValue(record, 'upperBinId'),
      activeBinId: typeof record.poolActiveBinId === 'number' ? record.poolActiveBinId : null,
      activePrice: nullableString(record, 'poolActivePrice'),
      isClosed: record.isClosed === true,
      isOutOfRange: booleanValue(record, 'isOutOfRange'),
      pnlUsd: stringValue(record, 'pnlUsd', '0'),
      pnlPct: stringValue(record, 'pnlPctChange', '0'),
      feeTvl24hPct: stringValue(record, 'feePerTvl24h', '0'),
      createdAt: typeof record.createdAt === 'number' ? new Date(record.createdAt * 1000).toISOString() : null,
      closedAt: typeof record.closedAt === 'number' ? new Date(record.closedAt * 1000).toISOString() : null,
    }))

    return {
      data: {
        items,
        page: result.data.page,
        pageSize: result.data.pageSize,
        total: result.data.totalCount,
        totalPages: Math.ceil(result.data.totalCount / Math.max(1, result.data.pageSize)),
        hasNext: result.data.hasNext,
      },
      freshness: result.freshness,
    }
  }

  async getPositionHistory(positionAddress: string): Promise<MeteoraResult<MeteoraPositionEvent[]>> {
    assertSolanaAddress(positionAddress, 'positionAddress')
    const result = await this.request<RawPositionHistory>(
      `/positions/${encodeURIComponent(positionAddress)}/historical`,
      {},
      METEORA_CACHE_POLICY.positions,
    )

    return {
      data: result.data.events.map((record) => ({
        signature: stringValue(record, 'signature'),
        instructionIndex: numberValue(record, 'ixIndex'),
        eventType: stringValue(record, 'eventType'),
        positionAddress: stringValue(record, 'positionAddress'),
        poolAddress: stringValue(record, 'poolAddress'),
        walletAddress: stringValue(record, 'userAddress'),
        tokenXSymbol: stringValue(record, 'tokenX'),
        tokenYSymbol: stringValue(record, 'tokenY'),
        amountX: stringValue(record, 'amountX', '0'),
        amountY: stringValue(record, 'amountY', '0'),
        amountXUsd: stringValue(record, 'amountXUsd', '0'),
        amountYUsd: stringValue(record, 'amountYUsd', '0'),
        totalUsd: stringValue(record, 'totalUsd', '0'),
        blockTime: numberValue(record, 'blockTime'),
        slot: numberValue(record, 'slot'),
        createdAt: stringValue(record, 'createdAt'),
      })),
      freshness: result.freshness,
    }
  }

  async getLimitOrderSummary(walletAddress: string): Promise<MeteoraResult<MeteoraLimitOrderSummary>> {
    assertSolanaAddress(walletAddress, 'walletAddress')
    const result = await this.request<RawLimitOrderSummary>(
      `/wallets/${encodeURIComponent(walletAddress)}/limit_orders/summary`,
      {},
      METEORA_CACHE_POLICY.limitOrders,
    )
    return {
      data: {
        openOrders: result.data.open_orders,
        closedOrders: result.data.closed_orders,
        totalDepositUsd: result.data.total_deposit_usd,
        totalDepositSol: result.data.total_deposit_sol,
        totalBonusUsd: result.data.total_bonus_usd,
        totalBonusSol: result.data.total_bonus_sol,
      },
      freshness: result.freshness,
    }
  }

  async getOpenLimitOrderPools(
    walletAddress: string,
    page = 1,
    pageSize = 20,
  ): Promise<MeteoraResult<MeteoraPage<MeteoraLimitOrderPool>>> {
    assertSolanaAddress(walletAddress, 'walletAddress')
    const result = await this.request<RawPage<Record<string, unknown>>>(
      `/wallets/${encodeURIComponent(walletAddress)}/limit_orders/open/pools`,
      {
        page: Math.max(1, page),
        page_size: Math.min(METEORA_MAX_PAGE_SIZE.limitOrders, Math.max(1, pageSize)),
      },
      METEORA_CACHE_POLICY.limitOrders,
    )

    const items = result.data.data.map((record) => {
      const pool = (record.pool ?? {}) as Record<string, unknown>
      // The limit-orders pools endpoint, like the portfolio endpoint, never
      // sends decimals or verified status — null is the honest unknown, not
      // the fabricated decimals: 0 / verified: true this used to hardcode.
      return {
        poolAddress: stringValue(pool, 'pool_address'),
        pair: stringValue(pool, 'pair_name'),
        tokenX: {
          address: stringValue(pool, 'token_x_mint'),
          symbol: stringValue(pool, 'token_x'),
          name: stringValue(pool, 'token_x'),
          decimals: null,
          iconUrl: nullableString(pool, 'token_x_icon'),
          verified: null,
        },
        tokenY: {
          address: stringValue(pool, 'token_y_mint'),
          symbol: stringValue(pool, 'token_y'),
          name: stringValue(pool, 'token_y'),
          decimals: null,
          iconUrl: nullableString(pool, 'token_y_icon'),
          verified: null,
        },
        binStep: numberValue(pool, 'bin_step'),
        baseFeePct: stringValue(pool, 'base_fee', '0'),
        totalOrders: numberValue(record, 'total_orders'),
        fullyFilledOrders: numberValue(record, 'fully_filled_orders'),
        filledPct: stringValue(record, 'filled_pct', '0'),
        totalDepositUsd: stringValue(record, 'total_deposit_usd', '0'),
        totalDepositSol: stringValue(record, 'total_deposit_sol', '0'),
        totalBonusUsd: stringValue(record, 'total_bonus_usd', '0'),
        totalBonusSol: stringValue(record, 'total_bonus_sol', '0'),
      }
    })

    return {
      data: {
        items,
        page: result.data.current_page,
        pageSize: result.data.page_size,
        total: result.data.total,
        totalPages: result.data.pages,
        hasNext: result.data.current_page < result.data.pages,
      },
      freshness: result.freshness,
    }
  }

  private async request<T>(
    path: string,
    query: Record<string, string | number | boolean | undefined>,
    policy: CachePolicy,
  ): Promise<MeteoraResult<T>> {
    const url = this.buildUrl(path, query)
    const now = Date.now()
    const cached = this.cache.get(url)
    if (cached && now < cached.expiresAt) {
      return {
        data: cached.value as T,
        freshness: this.freshness('fresh', cached.fetchedAt),
      }
    }

    const pending = this.inFlight.get(url)
    if (pending) {
      const value = await pending
      const entry = this.cache.get(url)
      return {
        data: value as T,
        freshness: this.freshness('fresh', entry?.fetchedAt ?? Date.now()),
      }
    }

    const request = this.fetchWithRetry<T>(url)
      .then((value) => {
        const fetchedAt = Date.now()
        this.cache.set(url, {
          value,
          fetchedAt,
          expiresAt: fetchedAt + policy.freshMs,
          staleUntil: fetchedAt + policy.staleMs,
        })
        return value
      })
      .finally(() => this.inFlight.delete(url))

    this.inFlight.set(url, request)

    try {
      const value = await request
      return { data: value, freshness: this.freshness('live', Date.now()) }
    } catch (error) {
      if (cached && now < cached.staleUntil) {
        return {
          data: cached.value as T,
          freshness: this.freshness('stale', cached.fetchedAt),
        }
      }
      throw error
    }
  }

  private async fetchWithRetry<T>(url: string): Promise<T> {
    let lastError: unknown
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
      try {
        const response = await this.fetcher(url, {
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        })
        if (response.status === 429) {
          throw new MeteoraClientError(
            'UPSTREAM_RATE_LIMITED',
            'Meteora Data API rate limit reached',
            response.status,
          )
        }
        if (!response.ok) {
          const message = await response.text().catch(() => '')
          throw new MeteoraClientError(
            response.status >= 500 ? 'UPSTREAM_UNAVAILABLE' : 'UPSTREAM_RESPONSE_INVALID',
            message || `Meteora Data API request failed with ${response.status}`,
            response.status,
          )
        }
        return (await response.json()) as T
      } catch (error) {
        lastError = error
        const retryable =
          error instanceof MeteoraClientError
            ? error.code === 'UPSTREAM_RATE_LIMITED' || error.code === 'UPSTREAM_UNAVAILABLE'
            : true
        if (!retryable || attempt === this.maxRetries) break
        await new Promise((resolve) => setTimeout(resolve, Math.min(250 * 2 ** attempt, 1_000)))
      } finally {
        clearTimeout(timeout)
      }
    }

    if (lastError instanceof MeteoraClientError) throw lastError
    throw new MeteoraClientError('UPSTREAM_UNAVAILABLE', 'Meteora Data API is unavailable', null, lastError)
  }

  private buildUrl(
    path: string,
    query: Record<string, string | number | boolean | undefined>,
  ): string {
    const url = new URL(`${this.baseUrl}${path}`)
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== '') url.searchParams.set(key, String(value))
    }
    return url.toString()
  }

  private freshness(state: MeteoraFreshness['state'], fetchedAt: number): MeteoraFreshness {
    return {
      state,
      source: 'meteora_data_api',
      servedAt: new Date().toISOString(),
      ageMs: Math.max(0, Date.now() - fetchedAt),
    }
  }
}
