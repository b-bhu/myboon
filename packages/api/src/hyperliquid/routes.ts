import { Hono } from 'hono'
import type { HyperliquidCandlesResponse, MarketCandle } from '@myboon/shared/stories'
import {
  CANDLE_INTERVALS,
  isCandleInterval,
  parseCandleCount,
  type CandleInterval,
  type HyperliquidPriceService,
} from './prices.js'

/**
 * `GET /market/hyperliquid/candles#691`: OHLCV candles for the details chart,
 * served from the shared Hyperliquid price service. Display only — no trading.
 */
export function createHyperliquidRoutes(options: { prices: HyperliquidPriceService }): Hono {
  const routes = new Hono()

  routes.get('/candles', async (c) => {
    const symbol = c.req.query('symbol')
    if (!symbol) return c.json({ error: 'Missing symbol' }, 400)

    const interval = c.req.query('interval') ?? '1h'
    if (!isCandleInterval(interval)) {
      return c.json({ error: 'Unsupported interval', supportedIntervals: [...CANDLE_INTERVALS] }, 400)
    }
    const count = parseCandleCount(c.req.query('count'))

    const listed = await options.prices.isListed(symbol)
    if (listed === 'unavailable') return c.json({ error: 'Prices unavailable' }, 503)
    if (!listed) return c.json({ error: 'Market not found' }, 404)

    try {
      const candles: MarketCandle[] = await options.prices.candles(symbol, interval as CandleInterval, count)
      const body: HyperliquidCandlesResponse = { symbol, interval, candles }
      return c.json(body)
    } catch (error) {
      console.error('[hyperliquid] candles upstream failed', error instanceof Error ? error.message : 'unknown error')
      return c.json({ error: 'Candles unavailable' }, 502)
    }
  })

  return routes
}
