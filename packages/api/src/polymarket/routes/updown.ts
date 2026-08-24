import { Hono } from 'hono'
import {
  type UpDownReadService,
  PolymarketUpDownService,
} from '../read/updown.js'

interface UpDownRoutesConfig {
  service?: UpDownReadService
}

export function createPolymarketUpDownRoutes(config: UpDownRoutesConfig = {}): Hono {
  const routes = new Hono()
  const service = config.service ?? new PolymarketUpDownService()

  routes.get('/updown', async (c) => {
    try {
      const rounds = await service.getRounds()
      c.header('Cache-Control', 'public, max-age=5, stale-while-revalidate=15')
      return c.json(rounds)
    } catch (error) {
      console.error('[api] GET /polymarket/updown failed:', error instanceof Error ? error.message : error)
      return c.json({ error: 'Internal server error' }, 500)
    }
  })

  routes.get('/updown/:asset/:duration/history', async (c) => {
    const asset = c.req.param('asset').toLowerCase()
    const duration = c.req.param('duration').toLowerCase()
    if ((asset !== 'btc' && asset !== 'eth') || (duration !== 'hourly' && duration !== 'daily')) {
      return c.json({
        error: 'Bad request',
        detail: 'asset must be btc or eth; duration must be hourly or daily',
      }, 400)
    }

    try {
      const history = await service.getHistory(asset, duration)
      if (!history) return c.json({ error: 'No active round' }, 404)
      c.header('Cache-Control', 'public, max-age=5, stale-while-revalidate=15')
      return c.json(history)
    } catch (error) {
      console.error(`[api] GET /polymarket/updown/${asset}/${duration}/history failed:`, error instanceof Error ? error.message : error)
      return c.json({ error: 'Upstream price history unavailable' }, 502)
    }
  })

  return routes
}
