import { serve } from '@hono/node-server'
import { startMarketReadPolling } from '../polymarket/read/market-read.js'
import { upDownLivePriceFeed } from '../polymarket/read/updown-prices.js'
import { loadApiConfig } from './config.js'
import { createApp } from './create-app.js'
import { createRpcRateLimiter } from '../rpc/routes.js'
import { attachRpcWebSocketBridge } from '../rpc/websocket.js'

export function startApiServer(): void {
  const config = loadApiConfig()
  const rpcRateLimiter = createRpcRateLimiter()
  const app = createApp(config, { rpcRateLimiter })
  startMarketReadPolling()
  upDownLivePriceFeed.start()

  // No token identity refresh loop: there is no snapshot table. Identity comes
  // from the checked-in seed (loaded at module init) for perps and majors, and
  // from the Jupiter mint cache (filled on demand) for the long tail. Icons are
  // bytes on disk under packages/api/assets/token-icons. Nothing here needs a
  // periodic database read.

  const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, () => {
    console.log(`[api] Listening on http://${config.host}:${config.port}`)
  })
  attachRpcWebSocketBridge(server, {
    solanaRpcUrl: config.solanaRpcUrl ?? 'https://api.mainnet-beta.solana.com',
    solanaDevnetRpcUrl: config.solanaDevnetRpcUrl ?? 'https://api.devnet.solana.com',
    polygonRpcUrl: config.polygonRpcUrl ?? 'https://polygon-rpc.com',
    solanaWsRpcUrl: config.solanaWsRpcUrl,
    solanaDevnetWsRpcUrl: config.solanaDevnetWsRpcUrl,
    trustForwardedHeaders: config.trustProxyHeaders,
    rateLimiter: rpcRateLimiter,
  })
}
