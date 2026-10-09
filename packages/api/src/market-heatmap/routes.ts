import { Hono } from 'hono'
import { MARKET_HEATMAP_INTERVALS, type MarketHeatmapInterval } from './types.js'
import { MarketHeatmapService, type MarketHeatmapServiceOptions } from './service.js'

export interface CreateMarketHeatmapRoutesOptions extends MarketHeatmapServiceOptions {
  service?: Pick<MarketHeatmapService, 'getHeatmap'>
}

export function createMarketHeatmapRoutes(
  options: CreateMarketHeatmapRoutesOptions = {},
): Hono {
  const routes = new Hono()
  const service = options.service ?? new MarketHeatmapService(options)

  routes.get('/token-heatmap', async (c) => {
    const interval = c.req.query('interval') ?? '24h'
    const chain = c.req.query('chain')
    if (!isMarketHeatmapInterval(interval)) {
      return c.json({ error: 'Bad request', detail: 'interval must be one of 5m, 1h, 6h, 24h' }, 400)
    }
    if (chain !== undefined && chain !== 'solana') {
      return c.json({ error: 'Bad request', detail: 'chain must be solana' }, 400)
    }

    const result = await service.getHeatmap(interval)
    return c.json(result, result.status === 'unavailable' ? 503 : 200)
  })

  return routes
}

function isMarketHeatmapInterval(value: string): value is MarketHeatmapInterval {
  return (MARKET_HEATMAP_INTERVALS as readonly string[]).includes(value)
}
