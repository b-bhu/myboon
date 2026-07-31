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
import { registerOperationRoutes } from './polymarket/trading/routes/operations.js'
import { registerOrderRoutes } from './polymarket/trading/routes/orders.js'
import { registerProxyRoutes } from './polymarket/trading/routes/proxies.js'
import { registerRedeemRoutes } from './polymarket/trading/routes/redeem.js'
import { registerSessionRoutes } from './polymarket/trading/routes/session.js'

export const clobRoutes = new Hono()

registerOperationRoutes(clobRoutes)
registerSessionRoutes(clobRoutes)
registerOrderRoutes(clobRoutes)
registerFundRoutes(clobRoutes)
registerRedeemRoutes(clobRoutes)
registerProxyRoutes(clobRoutes)
registerBuilderSignRoutes(clobRoutes)

console.log('[clob] Routes loaded: /auth, /order, /positions/:polygonAddress, /balance/:polygonAddress, /redeem')
