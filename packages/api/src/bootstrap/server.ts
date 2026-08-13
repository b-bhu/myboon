import { serve } from '@hono/node-server'
import { startMarketReadPolling } from '../polymarket/read/market-read.js'
import { SupabaseTokenIdentityStore } from '../tokens/identity-store.js'
import { startTokenIdentityRefresh } from '../tokens/identity-service.js'
import { loadApiConfig } from './config.js'
import { createApp } from './create-app.js'

export function startApiServer(): void {
  const config = loadApiConfig()
  const app = createApp(config)
  startMarketReadPolling()

  // identity-service.ts's warm maps (snapshot + seed) are the single source
  // of truth for both resolveRef() and iconSourceUrlForAssetId() — the icon
  // proxy (tokens/icon-proxy.ts) has no warm state of its own, so one
  // refresh loop keeps everything in sync.
  const tokenIdentityStore = new SupabaseTokenIdentityStore(config.supabaseUrl, config.supabaseServiceRoleKey)
  startTokenIdentityRefresh({ store: tokenIdentityStore, enabled: config.tokenIdentityEnabled })

  serve({ fetch: app.fetch, port: config.port, hostname: config.host }, () => {
    console.log(`[api] Listening on http://${config.host}:${config.port}`)
  })
}
