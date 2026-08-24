import { Hono } from 'hono'
import { PolymarketSearchService } from '../read/search.js'

interface SearchRoutesConfig {
  service?: Pick<PolymarketSearchService, 'search'>
}

export function createPolymarketSearchRoutes(config: SearchRoutesConfig = {}): Hono {
  const routes = new Hono()
  const service = config.service ?? new PolymarketSearchService()

  routes.get('/search', async (c) => {
    const query = (c.req.query('q') ?? '').trim()
    if (query.length < 2 || query.length > 100) {
      return c.json({ error: 'Bad request', detail: 'q must be between 2 and 100 characters' }, 400)
    }

    const page = Number(c.req.query('page') ?? 1)
    const limit = Number(c.req.query('limit') ?? 10)
    if (!Number.isFinite(page) || !Number.isFinite(limit)) {
      return c.json({ error: 'Bad request', detail: 'page and limit must be numbers' }, 400)
    }

    try {
      const result = await service.search(query, page, limit)
      c.header('Cache-Control', 'public, max-age=30, stale-while-revalidate=60')
      return c.json(result)
    } catch (error) {
      console.error('[api] GET /polymarket/search failed:', error instanceof Error ? error.message : error)
      return c.json({ error: 'Search upstream unavailable' }, 502)
    }
  })

  return routes
}
