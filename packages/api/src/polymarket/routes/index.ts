import { Hono } from 'hono'
import type { PolymarketCatalogStore } from '../catalog/contracts.js'
import type { UpDownReadService } from '../read/updown.js'
import { createPolymarketAccountRoutes } from './accounts.js'
import { createPolymarketCollectionRoutes } from './collections.js'
import { createPolymarketMarketRoutes } from './markets.js'
import { createPolymarketSearchRoutes } from './search.js'
import { createPolymarketSportsRoutes } from './sports.js'
import { createPolymarketUpDownRoutes } from './updown.js'

interface PolymarketReadRoutesConfig {
  catalogStore?: PolymarketCatalogStore
  upDownService?: UpDownReadService
}

/** Compose the existing Polymarket read API without starting timers or a server. */
export function createPolymarketReadRoutes(config: PolymarketReadRoutesConfig = {}): Hono {
  const routes = new Hono()
  routes.route('/collections', createPolymarketCollectionRoutes({ store: config.catalogStore }))
  routes.route('/', createPolymarketUpDownRoutes({ service: config.upDownService }))
  routes.route('/', createPolymarketSearchRoutes())
  routes.route('/', createPolymarketMarketRoutes())
  routes.route('/', createPolymarketSportsRoutes())
  routes.route('/', createPolymarketAccountRoutes())
  return routes
}
