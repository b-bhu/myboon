import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { createAiRoutes } from '../ai/routes.js'
import { clobRoutes } from '../clob.js'
import { createInternalEntityCommandRoutes } from '../internal/entity-commands.js'
import { createInternalEntityRoutes } from '../internal/entities.js'
import { createInternalPolymarketCatalogRoutes } from '../internal/polymarket-catalog.js'
import { createNarrativeRoutes } from '../narratives.js'
import { pacificaRoutes } from '../pacifica.js'
import { phoenixRoutes } from '../phoenix.js'
import { createPolymarketReadRoutes } from '../polymarket/routes/index.js'
import { SupabasePolymarketCatalogStore } from '../polymarket/catalog/supabase-store.js'
import { PolymarketUpDownService } from '../polymarket/read/updown.js'
import {
  SupabaseUpDownReferencePriceStore,
  UpDownPriceService,
} from '../polymarket/read/updown-prices.js'
import { spotRoutes } from '../spot.js'
import { createStoryRoutes } from '../stories.js'
import { createSwapRoutes } from '../swap.js'
import { createSqliteSwapExecutionStore } from '../swap/store.js'
import {
  iconSourceUrlForAssetId,
  iconSourceUrlForMint,
  resolveCatalog,
  resolveRef,
  warmMintIdentities,
} from '../tokens/identity-service.js'
import { createTokenRoutes } from '../tokens/routes.js'
import type { ApiConfig } from './config.js'

export function createApp(config: ApiConfig): Hono {
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

  const publicCors = cors()
  app.use('*', async (c, next) => {
    if (c.req.path === '/internal' || c.req.path.startsWith('/internal/')) return next()
    return publicCors(c, next)
  })
  app.use('*', logger())

  if (!config.internalDashboardToken || Buffer.byteLength(config.internalDashboardToken, 'utf8') < 32) {
    console.warn('[api] INTERNAL_DASHBOARD_TOKEN must be at least 32 bytes; /internal routes will return 503.')
  }
  if (!config.internalEntityWriteToken || Buffer.byteLength(config.internalEntityWriteToken, 'utf8') < 32) {
    console.warn('[api] INTERNAL_ENTITY_WRITE_TOKEN must be at least 32 bytes; /internal/entity-commands routes will return 503.')
  }
  if (!config.internalPolymarketCatalogWriteToken || Buffer.byteLength(config.internalPolymarketCatalogWriteToken, 'utf8') < 32) {
    console.warn('[api] INTERNAL_POLYMARKET_CATALOG_WRITE_TOKEN must be at least 32 bytes; Polymarket catalog writes will return 503.')
  }

  app.route('/internal/entity-commands', createInternalEntityCommandRoutes({
    supabaseUrl: config.supabaseUrl,
    serviceRoleKey: config.supabaseServiceRoleKey,
    internalWriteToken: config.internalEntityWriteToken,
  }))
  // Mount specific internal route groups before the broad /internal router,
  // whose wildcard read-token middleware would otherwise intercept writes.
  app.route('/internal/polymarket/collections', createInternalPolymarketCatalogRoutes({
    internalReadToken: config.internalDashboardToken,
    internalWriteToken: config.internalPolymarketCatalogWriteToken,
    store: polymarketCatalogStore,
  }))
  app.route('/internal', createInternalEntityRoutes({
    supabaseUrl: config.supabaseUrl,
    serviceRoleKey: config.supabaseServiceRoleKey,
    internalToken: config.internalDashboardToken,
  }))
  app.route('/stories', createStoryRoutes({
    supabaseUrl: config.supabaseUrl,
    serviceRoleKey: config.supabaseServiceRoleKey,
  }))
  app.route('/narratives', createNarrativeRoutes({
    supabaseUrl: config.supabaseUrl,
    serviceRoleKey: config.supabaseServiceRoleKey,
  }))

  app.route('/clob', clobRoutes)
  app.route('/perps/pacifica', pacificaRoutes)
  app.route('/perps/phoenix', phoenixRoutes)
  app.route('/spot', spotRoutes)
  app.route('/tokens', createTokenRoutes({
    enabled: config.tokenIdentityEnabled,
    service: {
      resolveRef,
      iconSourceUrlForAssetId,
      resolveCatalog,
      iconSourceUrlForMint,
      warmMintIdentities,
    },
  }))
  app.route('/swap', createSwapRoutes({
    jupApiKey: config.jupApiKey,
    jupApiBase: config.jupApiBase,
    identity: { resolveRef, warmMintIdentities },
    priorityFeeMaxLamports: config.swapPriorityFeeMaxLamports,
    tradingEnabled: config.swapTradingEnabled,
    store: createSqliteSwapExecutionStore(config.swapSqlitePath ?? '.data/swap.sqlite'),
    observe: (event) => console.info('[swap:event]', JSON.stringify(event)),
  }))

  app.get('/health', (c) => c.json({ status: 'ok' }))

  app.route('/ai', createAiRoutes({
    supabaseUrl: config.supabaseUrl,
    serviceRoleKey: config.supabaseServiceRoleKey,
    provider: config.aiExplanationProvider,
    apiKey: config.aiExplanationApiKey,
    baseUrl: config.aiExplanationBaseUrl,
    model: config.aiExplanationModel,
  }))

  app.route('/polymarket', createPolymarketReadRoutes({
    catalogStore: polymarketCatalogStore,
    upDownService,
  }))

  return app
}
