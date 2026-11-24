/**
 * Server-side Polymarket CLOB V2 composition root.
 *
 * The public `/clob` contract remains defined by the caller that mounts this
 * router. Trading runtime, sessions, transaction builders, and route groups
 * live under `polymarket/trading` so this module stays a small facade.
 */

import { Hono } from 'hono'
import { registerBuilderSignRoutes, type BuilderCredentials } from './polymarket/trading/routes/builder-sign.js'
import { registerFundRoutes } from './polymarket/trading/routes/funds.js'
import { registerProxyRoutes } from './polymarket/trading/routes/proxies.js'

/** Every value is optional; an omitted one takes the polymarket/trading/contracts.ts default (builder credentials: none, so builder routes refuse). */
export type ClobRouteOptions = {
  clobHost?: string
  relayerUrl?: string
  bridgeUrl?: string
  builderCode?: string
  builder?: BuilderCredentials
}

export function createClobRoutes(options: ClobRouteOptions = {}): Hono {
  const routes = new Hono()
  registerFundRoutes(routes, { bridgeUrl: options.bridgeUrl, builderCode: options.builderCode })
  registerProxyRoutes(routes, {
    clobHost: options.clobHost,
    relayerUrl: options.relayerUrl,
    builder: options.builder,
  })
  registerBuilderSignRoutes(routes, options.builder)
  console.log('[clob] Routes loaded: transparent CLOB/Relayer proxies, Builder signing, stateless Bridge proxies')
  return routes
}
