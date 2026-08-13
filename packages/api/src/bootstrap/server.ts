import { serve } from '@hono/node-server'
import { startMarketReadPolling } from '../polymarket/read/market-read.js'
import { loadApiConfig } from './config.js'
import { createApp } from './create-app.js'

export function startApiServer(): void {
  const config = loadApiConfig()
  const app = createApp(config)
  startMarketReadPolling()

  // No token identity refresh loop: there is no snapshot table. Identity comes
  // from the checked-in seed (loaded at module init) for perps and majors, and
  // from the Jupiter mint cache (filled on demand) for the long tail. Icons are
  // bytes on disk under packages/api/assets/token-icons. Nothing here needs a
  // periodic database read.

  serve({ fetch: app.fetch, port: config.port, hostname: config.host }, () => {
    console.log(`[api] Listening on http://${config.host}:${config.port}`)
  })
}
