/**
 * Phoenix settings (#831). The env is read only in bootstrap/config.ts
 * (`loadPhoenixConfig`), which hands the values in through `overrides`; this
 * module owns the defaults, so an unset or invalid value keeps the same
 * default the module-level constants used to carry.
 */
export interface PhoenixConfig {
  /** PHOENIX_API_BASE */
  apiBase: string
  /** PHOENIX_WS_URL; defaults to the `/v1/ws` path on the API base. */
  wsUrl: string
  /** PHOENIX_RPC_URL, then SOLANA_RPC_URL. */
  rpcUrl: string
  /** PHOENIX_BUILDER_AUTHORITY */
  builderAuthority: string
  /** PHOENIX_BUILDER_PDA_INDEX (zero allowed). */
  builderPdaIndex: number
  /** PHOENIX_BUILDER_SUBACCOUNT_INDEX (zero allowed). */
  builderSubaccountIndex: number
  /** PHOENIX_REQUEST_TIMEOUT_MS */
  requestTimeoutMs: number
  /** PHOENIX_STATUS_CACHE_TTL_MS */
  statusCacheTtlMs: number
  /** PHOENIX_MARKETS_CACHE_TTL_MS */
  marketsCacheTtlMs: number
  /** PHOENIX_MARKET_STATS_CACHE_TTL_MS */
  marketStatsCacheTtlMs: number
  /** PHOENIX_MARKET_STATS_TIMEOUT_MS */
  marketStatsTimeoutMs: number
  /** PHOENIX_CANDLES_CACHE_TTL_MS */
  candlesCacheTtlMs: number
  /** PHOENIX_MAX_CANDLE_LIMIT */
  maxCandleLimit: number
}

const DEFAULT_API_BASE = 'https://perp-api.phoenix.trade'

export function createPhoenixConfig(overrides: Partial<PhoenixConfig> = {}): PhoenixConfig {
  const apiBase = overrides.apiBase ?? DEFAULT_API_BASE
  return {
    apiBase,
    wsUrl: overrides.wsUrl ?? `${apiBase.replace(/^http/i, 'ws').replace(/\/$/, '')}/v1/ws`,
    rpcUrl: overrides.rpcUrl ?? 'https://api.mainnet-beta.solana.com',
    builderAuthority: overrides.builderAuthority ?? '9R2btPADiQUZ4p7duXJJFxW9jnUeUqafb5Ln6DU8jnwu',
    builderPdaIndex: overrides.builderPdaIndex ?? 0,
    builderSubaccountIndex: overrides.builderSubaccountIndex ?? 0,
    requestTimeoutMs: overrides.requestTimeoutMs ?? 10_000,
    statusCacheTtlMs: overrides.statusCacheTtlMs ?? 15_000,
    marketsCacheTtlMs: overrides.marketsCacheTtlMs ?? 60_000,
    marketStatsCacheTtlMs: overrides.marketStatsCacheTtlMs ?? 10_000,
    marketStatsTimeoutMs: overrides.marketStatsTimeoutMs ?? 5_000,
    candlesCacheTtlMs: overrides.candlesCacheTtlMs ?? 15_000,
    maxCandleLimit: overrides.maxCandleLimit ?? 500,
  }
}
