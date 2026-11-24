import { DEFAULT_PRICES_TTL_MS } from '../hyperliquid.js'
import {
  DEFAULT_BRIDGE_URL,
  DEFAULT_CLOB_HOST,
  DEFAULT_POLYMARKET_BUILDER_CODE,
  DEFAULT_RELAYER_URL,
} from '../polymarket/trading/contracts.js'

export type ApiConfig = {
  supabaseUrl: string
  supabaseServiceRoleKey: string
  internalDashboardToken?: string
  internalPolymarketCatalogWriteToken?: string
  port: number
  host: string
  /** HYPERLIQUID_PRICES_TTL_MS: createHyperliquidPrices()'s freshness window. */
  hyperliquidPricesTtlMs: number
  tokenIdentityEnabled: boolean
  tokenRegistryEnabled: boolean
  tokenRegistryLruMax: number
  tokenRegistryFoundTtlMs: number
  tokenRegistryMissTtlMs: number
  tokenRegistryStaleAfterMs: number
  tokenUpstreamMaxConcurrency: number
  tokenUpstreamRpm: number
  tokenUpstreamCooldownMs: number
  tokenUpstreamMaxPerRequest: number
  tokenUpstreamRequestBudgetMs: number
  tokenUpstreamQueueMax: number
  tokensApiKey?: string
  jupApiKey?: string
  jupApiBase?: string
  /** JUPITER_API_BASE: token-search base override; unset keeps the lite-api.jup.ag default. */
  jupiterApiBase?: string
  /** CLOB_HOST: Polymarket CLOB base for the market reads and /clob proxies; unset keeps clob.polymarket.com. */
  polymarketClobHost: string
  /** POLYMARKET_RELAYER_URL: Relayer base for /clob/relayer-proxy; unset keeps relayer-v2.polymarket.com. */
  polymarketRelayerUrl: string
  /** POLYMARKET_BRIDGE_URL: Bridge base for the /clob/bridge routes; unset keeps bridge.polymarket.com. */
  polymarketBridgeUrl: string
  /** POLYMARKET_BUILDER_CODE: public attribution code sent on Bridge requests. */
  polymarketBuilderCode: string
  /** POLYMARKET_BUILDER_API_KEY/SECRET/PASSPHRASE: missing values make /clob/builder/sign refuse, never sign. */
  polymarketBuilderApiKey?: string
  polymarketBuilderSecret?: string
  polymarketBuilderPassphrase?: string
  /** Relay's wallet Move key, read from RELAY_API_KEY; optional so a missing key degrades instead of stopping the API. */
  relayApiKey?: string
  swapPriorityFeeMaxLamports?: string
  swapSqlitePath?: string
  swapTradingEnabled?: boolean
  calendarBackpackEnabled?: boolean
  birdeyeApiKey?: string
  solanaRpcUrl?: string
  solanaDevnetRpcUrl?: string
  polygonRpcUrl?: string
  solanaWsRpcUrl?: string
  solanaDevnetWsRpcUrl?: string
  trustProxyHeaders?: boolean
}

export function loadApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const supabaseUrl = env.SUPABASE_URL
  const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY
  const jupApiKey = env.JUP_API_KEY
  const missing: string[] = []
  if (!supabaseUrl) missing.push('SUPABASE_URL')
  if (!supabaseServiceRoleKey) missing.push('SUPABASE_SERVICE_ROLE_KEY')
  if (!jupApiKey) missing.push('JUP_API_KEY')

  if (missing.length > 0) {
    console.error(`[api] Missing required env vars: ${missing.join(', ')}`)
    process.exit(1)
  }

  // Relay's wallet Move key (Decision Log D55: server-side, never in the app).
  // Its absence is a degraded mode, not a startup failure: the API still
  // serves every other route.
  const relayApiKey = env.RELAY_API_KEY?.trim() || undefined
  if (!relayApiKey) {
    console.warn(
      '[api] RELAY_API_KEY is not set; wallet Move quote/status routes will return 503 until it is configured',
    )
  }

  const tokenIdentityEnabled = env.TOKEN_IDENTITY_ENABLED === '1' || env.TOKEN_IDENTITY_ENABLED === 'true'
  const tokenRegistryEnabled = env.TOKEN_REGISTRY_ENABLED === '1' || env.TOKEN_REGISTRY_ENABLED === 'true'
  const positiveInt = (name: string, fallback: number): number => {
    const raw = env[name]
    if (!raw || !/^\d+$/.test(raw)) return fallback
    const value = Number(raw)
    return Number.isSafeInteger(value) && value > 0 ? value : fallback
  }
  // Same values createHyperliquidPrices used to read inline: a safe positive
  // integer wins, anything else (unset, NaN, 0, negative) keeps the default.
  const envPricesTtlMs = Number(env.HYPERLIQUID_PRICES_TTL_MS)
  const hyperliquidPricesTtlMs = Number.isSafeInteger(envPricesTtlMs) && envPricesTtlMs > 0
    ? envPricesTtlMs
    : DEFAULT_PRICES_TTL_MS

  // Polymarket env: same fallbacks the trading and read modules used to read inline.
  const polymarketClobHost = env.CLOB_HOST || DEFAULT_CLOB_HOST
  const polymarketRelayerUrl = env.POLYMARKET_RELAYER_URL || DEFAULT_RELAYER_URL
  const polymarketBridgeUrl = env.POLYMARKET_BRIDGE_URL || DEFAULT_BRIDGE_URL
  const polymarketBuilderCode = env.POLYMARKET_BUILDER_CODE || DEFAULT_POLYMARKET_BUILDER_CODE

  const solanaRpcUrl = env.SOLANA_RPC_URL?.trim() || env.HELIUS_RPC_URL?.trim() || 'https://api.mainnet-beta.solana.com'
  const solanaDevnetRpcUrl = env.SOLANA_DEVNET_RPC_URL?.trim() || 'https://api.devnet.solana.com'
  const polygonRpcUrl = env.POLYGON_RPC_URL?.trim() || 'https://polygon-rpc.com'

  // Keep the server-owned fee ceiling bounded even when deployment config is
  // incomplete. Invalid values fall back to a conservative one-million
  // lamport cap rather than allowing an unbounded provider request.
  const configuredPriorityFee = env.SWAP_PRIORITY_FEE_MAX_LAMPORTS
  const priorityFee = configuredPriorityFee && /^[0-9]+$/.test(configuredPriorityFee)
    && configuredPriorityFee.length <= 20
    && BigInt(configuredPriorityFee) <= 18_446_744_073_709_551_615n
    ? BigInt(configuredPriorityFee).toString()
    : '1000000'

  return {
    supabaseUrl: supabaseUrl!,
    supabaseServiceRoleKey: supabaseServiceRoleKey!,
    internalDashboardToken: env.INTERNAL_DASHBOARD_TOKEN,
    internalPolymarketCatalogWriteToken: env.INTERNAL_POLYMARKET_CATALOG_WRITE_TOKEN,
    port: parseInt(env.PORT ?? '3000', 10),
    host: env.HOST ?? '0.0.0.0',
    tokenIdentityEnabled,
    tokenRegistryEnabled,
    tokenRegistryLruMax: positiveInt('TOKEN_REGISTRY_LRU_MAX', 50_000),
    tokenRegistryFoundTtlMs: positiveInt('TOKEN_REGISTRY_FOUND_TTL_MS', 7 * 24 * 60 * 60 * 1000),
    tokenRegistryMissTtlMs: positiveInt('TOKEN_REGISTRY_MISS_TTL_MS', 10 * 60 * 1000),
    tokenRegistryStaleAfterMs: positiveInt('TOKEN_REGISTRY_STALE_AFTER_MS', 24 * 60 * 60 * 1000),
    tokenUpstreamMaxConcurrency: positiveInt('TOKEN_UPSTREAM_MAX_CONCURRENCY', 2),
    tokenUpstreamRpm: positiveInt('TOKEN_UPSTREAM_RPM', 30),
    tokenUpstreamCooldownMs: positiveInt('TOKEN_UPSTREAM_COOLDOWN_MS', 300_000),
    tokenUpstreamMaxPerRequest: positiveInt('TOKEN_UPSTREAM_MAX_PER_REQUEST', 50),
    tokenUpstreamRequestBudgetMs: positiveInt('TOKEN_UPSTREAM_REQUEST_BUDGET_MS', 2_000),
    tokenUpstreamQueueMax: positiveInt('TOKEN_UPSTREAM_QUEUE_MAX', 1000),
    hyperliquidPricesTtlMs,
    tokensApiKey: env.TOKENS_API_KEY,
    jupApiKey,
    jupApiBase: env.JUP_API_BASE,
    jupiterApiBase: env.JUPITER_API_BASE,
    polymarketClobHost,
    polymarketRelayerUrl,
    polymarketBridgeUrl,
    polymarketBuilderCode,
    polymarketBuilderApiKey: env.POLYMARKET_BUILDER_API_KEY,
    polymarketBuilderSecret: env.POLYMARKET_BUILDER_SECRET,
    polymarketBuilderPassphrase: env.POLYMARKET_BUILDER_PASSPHRASE,
    relayApiKey,
    swapPriorityFeeMaxLamports: priorityFee,
    swapSqlitePath: env.SWAP_SQLITE_PATH?.trim() || '.data/swap.sqlite',
    swapTradingEnabled: env.SWAP_TRADING_KILL_SWITCH !== '1' && env.SWAP_TRADING_KILL_SWITCH !== 'true',
    solanaRpcUrl,
    solanaDevnetRpcUrl,
    polygonRpcUrl,
    solanaWsRpcUrl: env.SOLANA_WS_RPC_URL?.trim() || undefined,
    solanaDevnetWsRpcUrl: env.SOLANA_DEVNET_WS_RPC_URL?.trim() || undefined,
    trustProxyHeaders: env.TRUST_PROXY_HEADERS === '1' || env.TRUST_PROXY_HEADERS === 'true',
    calendarBackpackEnabled: env.CALENDAR_BACKPACK_ENABLED !== '0' && env.CALENDAR_BACKPACK_ENABLED !== 'false',
    birdeyeApiKey: env.BIRDEYE_API_KEY?.trim() || undefined,
  }
}
