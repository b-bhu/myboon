export type ApiConfig = {
  supabaseUrl: string
  supabaseServiceRoleKey: string
  internalDashboardToken?: string
  internalPolymarketCatalogWriteToken?: string
  port: number
  host: string
  aiExplanationProvider: string
  aiExplanationApiKey?: string
  aiExplanationBaseUrl: string
  aiExplanationModel: string
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

  const aiExplanationProvider = env.AI_EXPLANATION_PROVIDER
    ?? (env.MINIMAX_API_KEY ? 'minimax' : (env.OPENAI_API_KEY ? 'openai' : 'xai'))
  const aiExplanationApiKey = env.AI_EXPLANATION_API_KEY
    ?? (aiExplanationProvider === 'minimax' ? env.MINIMAX_API_KEY : undefined)
    ?? env.OPENAI_API_KEY
    ?? env.XAI_API_KEY
  const aiExplanationBaseUrl = env.AI_EXPLANATION_BASE_URL
    ?? (aiExplanationProvider === 'minimax'
      ? 'https://api.minimax.io/anthropic/v1'
      : (env.OPENAI_API_KEY ? 'https://api.openai.com/v1' : 'https://api.x.ai/v1'))
  const aiExplanationModel = env.AI_EXPLANATION_MODEL
    ?? (aiExplanationProvider === 'minimax'
      ? (env.CLASSIFIER_MODEL ?? 'MiniMax-M2.7-lightning')
      : (env.OPENAI_API_KEY ? 'gpt-4o-mini' : (env.XAI_MODEL ?? 'grok-3-mini')))

  const tokenIdentityEnabled = env.TOKEN_IDENTITY_ENABLED === '1' || env.TOKEN_IDENTITY_ENABLED === 'true'
  const tokenRegistryEnabled = env.TOKEN_REGISTRY_ENABLED === '1' || env.TOKEN_REGISTRY_ENABLED === 'true'
  const positiveInt = (name: string, fallback: number): number => {
    const raw = env[name]
    if (!raw || !/^\d+$/.test(raw)) return fallback
    const value = Number(raw)
    return Number.isSafeInteger(value) && value > 0 ? value : fallback
  }
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
    aiExplanationProvider,
    aiExplanationApiKey,
    aiExplanationBaseUrl,
    aiExplanationModel,
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
    tokensApiKey: env.TOKENS_API_KEY,
    jupApiKey,
    jupApiBase: env.JUP_API_BASE,
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
