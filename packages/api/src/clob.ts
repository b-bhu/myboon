/**
 * Server-side Polymarket CLOB V2 composition root.
 *
 * The public `/clob` contract remains defined by the caller that mounts this
 * router. Trading runtime, sessions, transaction builders, and route groups
 * live under `polymarket/trading` so this module stays a small facade.
 */

import { Hono } from 'hono'
import { registerBuilderSignRoutes } from './polymarket/trading/routes/builder-sign.js'
import { registerFundRoutes } from './polymarket/trading/routes/funds.js'
import { registerProxyRoutes } from './polymarket/trading/routes/proxies.js'

export const clobRoutes = new Hono()

registerFundRoutes(clobRoutes)
registerProxyRoutes(clobRoutes)
registerBuilderSignRoutes(clobRoutes)

console.log('[clob] Routes loaded: transparent CLOB/Relayer proxies, Builder signing, stateless Bridge proxies')
