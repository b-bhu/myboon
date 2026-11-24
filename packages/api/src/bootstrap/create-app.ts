import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { createSupabaseClient } from '@myboon/shared/supabase-client'
import { createCalendarRoutes } from '../calendar/routes.js'
import { createMarketHeatmapRoutes } from '../market-heatmap/routes.js'
import { MarketHeatmapService } from '../market-heatmap/service.js'
import { createWalletActivityRoutes, createWalletActivityService } from '../wallet-activity/index.js'
import { createClobRoutes } from '../clob.js'
import { createInternalPolymarketCatalogRoutes } from '../internal/polymarket-catalog.js'
import { createLatestUpdateRoutes } from '../latest-updates.js'
import { configurePacificaClient } from '../pacifica/client.js'
import { createPacificaRoutes } from '../pacifica/routes.js'
import { phoenixRoutes } from '../phoenix.js'
import { createPolymarketReadRoutes } from '../polymarket/routes/index.js'
import { SupabasePolymarketCatalogStore } from '../polymarket/catalog/supabase-store.js'
import { PolymarketUpDownService } from '../polymarket/read/updown.js'
import {
  SupabaseUpDownReferencePriceStore,
  UpDownPriceService,
} from '../polymarket/read/updown-prices.js'
import { configureSpotBalances, createSpotBalances } from '../spot/balances.js'
import { createSpotRoutes } from '../spot/routes.js'
import { createWalletSummaryRoutes } from '../wallet-summary/routes.js'
import { createWalletSummaryService } from '../wallet-summary/service.js'
import { createWalletMoveRoutes } from '../wallet-move/routes.js'
import { createHyperliquidPrices } from '../hyperliquid.js'
import { createHyperliquidRoutes } from '../hyperliquid-routes.js'
import { createStoryRoutes } from '../stories.js'
import { createSwapRoutes } from '../swap.js'
import { createSqliteSwapExecutionStore } from '../swap/store.js'
import {
  iconSourceUrlForAssetId,
  iconSourceUrlForMint,
  resolveCatalog,
  resolveRef,
  warmMintIdentities,
  tokenRegistrySeeds,
  configureTokenIdentityFlag,
} from '../tokens/identity-service.js'
import { createOptionalTokenRegistry, TokenRegistry } from '../tokens/registry/token-registry.js'
import { SupabaseTokenRegistryStore } from '../tokens/registry/store.js'
import type { RegistryConfig } from '../tokens/registry/token-registry.js'
import { configureJupiterSearch } from '../tokens/jupiter-tokens.js'
import { configureClobBase } from '../polymarket/read/market-read.js'
import { createTokenRoutes } from '../tokens/routes.js'
import { createRpcRoutes, createRpcRateLimiter, type RpcRateLimiter } from '../rpc/routes.js'
import type { ApiConfig } from './config.js'

export function createApp(config: ApiConfig, options: { rpcRateLimiter?: RpcRateLimiter } = {}): Hono {
  // Env-derived settings arrive only through ApiConfig (#833): the venue
  // modules take their values from here instead of reading the raw env.
  configureTokenIdentityFlag(config.tokenIdentityEnabled)
  configureJupiterSearch({ apiBase: config.jupiterApiBase, apiKey: config.jupApiKey })
  configureClobBase(config.polymarketClobHost)
  // The wallet summary's Pacifica and spot venues read through these (#831);
  // /spot shares the same balances instance so both keep one cache.
  configurePacificaClient({ apiBase: config.pacificaApiBase })
  const spotBalances = createSpotBalances({ heliusRpcUrl: config.heliusRpcUrl })
  configureSpotBalances(spotBalances)
  const tokenRegistry = createOptionalTokenRegistry(config.tokenRegistryEnabled, () => new TokenRegistry({
    store: new SupabaseTokenRegistryStore(config.supabaseUrl, config.supabaseServiceRoleKey),
    seeds: tokenRegistrySeeds(),
    config: {
      lruMax: config.tokenRegistryLruMax, foundTtlMs: config.tokenRegistryFoundTtlMs,
      missTtlMs: config.tokenRegistryMissTtlMs, staleAfterMs: config.tokenRegistryStaleAfterMs,
      maxConcurrency: config.tokenUpstreamMaxConcurrency, rpm: config.tokenUpstreamRpm,
      cooldownMs: config.tokenUpstreamCooldownMs, maxPerRequest: config.tokenUpstreamMaxPerRequest,
      requestBudgetMs: config.tokenUpstreamRequestBudgetMs, queueMax: config.tokenUpstreamQueueMax,
    } satisfies RegistryConfig,
  }))
  if (tokenRegistry) tokenRegistry.counter.start()
  const registryWarm = tokenRegistry
    ? async (mints: readonly string[]) => { await tokenRegistry.lookupMany(mints) }
    : warmMintIdentities
  const resolveTokenRef = tokenRegistry
    ? (ref: string) => resolveRef(ref, { registryRowForMint: (mint) => tokenRegistry.getCachedRow(mint) })
    : resolveRef
  const registryIconSourceForMint = tokenRegistry
    ? (mint: string) => tokenRegistry.getCachedRow(mint)?.icon_source_url ?? null
    : iconSourceUrlForMint
  const app = new Hono()
  const polymarketCatalogStore = new SupabasePolymarketCatalogStore(
    config.supabaseUrl,
    config.supabaseServiceRoleKey,
  )
  const upDownReferenceStore = new SupabaseUpDownReferencePriceStore(
    config.supabaseUrl,
    config.supabaseServiceRoleKey,
  )
  const upDownService = new PolymarketUpDownService({
    priceService: new UpDownPriceService(upDownReferenceStore),
  })
  // One Hyperliquid price cache per process (#691), shared by /stories markets and the candles route.
  const hyperliquidPrices = createHyperliquidPrices({ ttlMs: config.hyperliquidPricesTtlMs })

  const publicCors = cors()
  app.use('*', async (c, next) => {
    if (c.req.path === '/internal' || c.req.path.startsWith('/internal/')) return next()
    return publicCors(c, next)
  })
  app.use('*', logger())

  if (!config.internalDashboardToken || Buffer.byteLength(config.internalDashboardToken, 'utf8') < 32) {
    console.warn('[api] INTERNAL_DASHBOARD_TOKEN must be at least 32 bytes; /internal routes will return 503.')
  }
  if (!config.internalPolymarketCatalogWriteToken || Buffer.byteLength(config.internalPolymarketCatalogWriteToken, 'utf8') < 32) {
    console.warn('[api] INTERNAL_POLYMARKET_CATALOG_WRITE_TOKEN must be at least 32 bytes; Polymarket catalog writes will return 503.')
  }

  app.route('/internal/polymarket/collections', createInternalPolymarketCatalogRoutes({
    internalReadToken: config.internalDashboardToken,
    internalWriteToken: config.internalPolymarketCatalogWriteToken,
    store: polymarketCatalogStore,
  }))
  app.route('/stories', createStoryRoutes({
    supabaseUrl: config.supabaseUrl,
    serviceRoleKey: config.supabaseServiceRoleKey,
    prices: hyperliquidPrices,
  }))
  app.route('/latest-updates', createLatestUpdateRoutes({
    supabaseUrl: config.supabaseUrl,
    serviceRoleKey: config.supabaseServiceRoleKey,
  }))

  app.route('/clob', createClobRoutes({
    clobHost: config.polymarketClobHost,
    relayerUrl: config.polymarketRelayerUrl,
    bridgeUrl: config.polymarketBridgeUrl,
    builderCode: config.polymarketBuilderCode,
    builder: {
      apiKey: config.polymarketBuilderApiKey,
      secret: config.polymarketBuilderSecret,
      passphrase: config.polymarketBuilderPassphrase,
    },
  }))
  app.route('/calendar', createCalendarRoutes({
    enabled: config.calendarBackpackEnabled,
    supabaseUrl: config.supabaseUrl,
    serviceRoleKey: config.supabaseServiceRoleKey,
    prices: hyperliquidPrices,
  }))
  const heatmapService = new MarketHeatmapService({ jupApiKey: config.jupApiKey, jupApiBase: config.jupApiBase })
  app.route('/market', createMarketHeatmapRoutes({ service: heatmapService }))
  app.route('/market', createWalletActivityRoutes({ service: createWalletActivityService({
    apiKey: config.birdeyeApiKey,
    getSeedTokens: async () => {
      const heatmap = await heatmapService.getHeatmap('24h')
      if (heatmap.status === 'unavailable') throw new Error('Verified token sample unavailable')
      return {
        tokens: heatmap.tokens.map(({ address, symbol, name }) => ({ address, symbol, name })),
        fetchedAt: heatmap.fetchedAt,
        stale: heatmap.stale,
      }
    },
  }) }))
  app.route('/market/hyperliquid', createHyperliquidRoutes({ prices: hyperliquidPrices }))
  app.route('/perps/pacifica', createPacificaRoutes({
    apiBase: config.pacificaApiBase,
    iconBase: config.pacificaIconBase,
  }))
  app.route('/perps/phoenix', phoenixRoutes)
  app.route('/spot', createSpotRoutes({ heliusRpcUrl: config.heliusRpcUrl, balances: spotBalances }))
  app.route('/wallet', createWalletSummaryRoutes({
    service: createWalletSummaryService(),
    // Per-IP rate-limit identity follows /rpc: TRUST_PROXY_HEADERS only (#743).
    trustForwardedHeaders: config.trustProxyHeaders,
  }))
  app.route('/wallet', createWalletMoveRoutes({
    relayApiKey: config.relayApiKey,
    // Per-IP rate-limit identity follows /rpc: TRUST_PROXY_HEADERS only (#743).
    trustForwardedHeaders: config.trustProxyHeaders,
  }))
  app.route('/rpc', createRpcRoutes({
    solanaRpcUrl: config.solanaRpcUrl ?? 'https://api.mainnet-beta.solana.com',
    solanaDevnetRpcUrl: config.solanaDevnetRpcUrl ?? 'https://api.devnet.solana.com',
    polygonRpcUrl: config.polygonRpcUrl ?? 'https://polygon-rpc.com',
    trustForwardedHeaders: config.trustProxyHeaders,
    rateLimiter: options.rpcRateLimiter ?? createRpcRateLimiter(),
  }))
  app.route('/tokens', createTokenRoutes({
    enabled: config.tokenIdentityEnabled,
    service: {
      resolveRef: resolveTokenRef,
      iconSourceUrlForAssetId,
      resolveCatalog,
      iconSourceUrlForMint: registryIconSourceForMint,
      warmMintIdentities: registryWarm,
    },
  }))
  app.route('/swap', createSwapRoutes({
    jupApiKey: config.jupApiKey,
    jupApiBase: config.jupApiBase,
    identity: { resolveRef: resolveTokenRef, warmMintIdentities: registryWarm },
    priorityFeeMaxLamports: config.swapPriorityFeeMaxLamports,
    tradingEnabled: config.swapTradingEnabled,
    store: createSqliteSwapExecutionStore(config.swapSqlitePath ?? '.data/swap.sqlite'),
    observe: (event) => console.info('[swap:event]', JSON.stringify(event)),
  }))

  app.get('/health', (c) => c.json({ status: 'ok' }))

  app.route('/polymarket', createPolymarketReadRoutes({
    catalogStore: polymarketCatalogStore,
    upDownService,
  }))

  return app
}
