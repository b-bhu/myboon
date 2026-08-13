import { Hono } from 'hono'
import { perpIconPath } from './tokens/identity-service.js'

const PACIFICA_API_BASE = process.env.PACIFICA_API_BASE || 'https://api.pacifica.fi/api/v1'
const PACIFICA_ICON_BASE = process.env.PACIFICA_ICON_BASE || 'https://app.pacifica.fi/imgs/tokens'
const MARKETS_CACHE_TTL_MS = 15_000
// Legacy negative-cache TTL: this is the flag-off path and also serves
// symbols the token identity perp map does not cover, so misses should not
// stay broken all day — matches the new proxy's ICON_NEGATIVE_TTL_MS policy
// (tokens/icon-proxy.ts).
const ICON_CACHE_TTL_MS = 24 * 60 * 60 * 1000
const ICON_NEGATIVE_CACHE_TTL_MS = 60 * 60 * 1000

const marketCache = new Map<string, { data: unknown; expiresAt: number }>()
const iconCache = new Map<string, { svg: string | null; expiresAt: number }>()

interface RawMarketInfo {
  symbol: string
  tick_size: string
  lot_size: string
  max_leverage: number
  min_order_size: string
  instrument_type: string
}

interface RawPriceInfo {
  symbol: string
  oracle: string
  mark: string
  mid: string
  funding: string
  open_interest: string
  volume_24h: string
  yesterday_price: string
}

interface PacificaMarket {
  symbol: string
  maxLeverage: number
  tickSize: string
  lotSize: string
  minOrderSize: string
  markPrice: number
  oraclePrice: number
  midPrice: number
  fundingRate: number
  openInterest: number
  volume24h: number
  change24h: number
  yesterdayPrice: number
  iconPath: string
}

function safeNumber(value: unknown): number {
  const parsed = Number.parseFloat(String(value))
  return Number.isFinite(parsed) ? parsed : 0
}

function tokenBase(symbol: string): string {
  return symbol.split('-')[0].replace(/[^A-Za-z0-9_]/g, '').toUpperCase()
}

async function pacificaGetJson<T>(path: string): Promise<T> {
  const res = await fetch(`${PACIFICA_API_BASE}${path}`)
  if (!res.ok) throw new Error(`Pacifica ${path} failed (${res.status})`)

  const json = await res.json() as { success?: boolean; data?: T; error?: string; message?: string }
  if (json.success === false) {
    throw new Error(json.error ?? json.message ?? `Pacifica ${path} failed`)
  }
  return json.data as T
}

async function getMarkets(): Promise<PacificaMarket[]> {
  const cacheKey = 'markets'
  const now = Date.now()
  const cached = marketCache.get(cacheKey)
  if (cached && cached.expiresAt > now) return cached.data as PacificaMarket[]

  const [markets, prices] = await Promise.all([
    pacificaGetJson<RawMarketInfo[]>('/info'),
    pacificaGetJson<RawPriceInfo[]>('/info/prices'),
  ])
  const priceMap = new Map(prices.map((price) => [price.symbol, price]))

  const data = markets
    .filter((market) => market.instrument_type === 'perpetual')
    .map((market): PacificaMarket | null => {
      const price = priceMap.get(market.symbol)
      if (!price) return null

      const markPrice = safeNumber(price.mark)
      const yesterdayPrice = safeNumber(price.yesterday_price)
      const change24h = yesterdayPrice > 0 ? ((markPrice - yesterdayPrice) / yesterdayPrice) * 100 : 0
      const iconBase = tokenBase(market.symbol)
      // perpIconPath() returns the token-identity-proxied path
      // (/tokens/icon/<assetId>) when the flag is on and the perp symbol
      // map hits; otherwise fall back to the legacy per-venue proxy below,
      // which stays the flag-off path and also covers symbols the frozen
      // perp map does not list.
      const iconPath = perpIconPath(market.symbol) ?? `/perps/pacifica/icons/${encodeURIComponent(iconBase)}.svg`

      return {
        symbol: market.symbol,
        maxLeverage: market.max_leverage,
        tickSize: market.tick_size,
        lotSize: market.lot_size,
        minOrderSize: market.min_order_size,
        markPrice,
        oraclePrice: safeNumber(price.oracle),
        midPrice: safeNumber(price.mid),
        fundingRate: safeNumber(price.funding),
        openInterest: safeNumber(price.open_interest),
        volume24h: safeNumber(price.volume_24h),
        change24h,
        yesterdayPrice,
        iconPath,
      }
    })
    .filter((market): market is PacificaMarket => market !== null)
    .sort((a, b) => b.volume24h - a.volume24h)

  marketCache.set(cacheKey, { data, expiresAt: now + MARKETS_CACHE_TTL_MS })
  return data
}

export const pacificaRoutes = new Hono()

// GET /perps/pacifica/markets
pacificaRoutes.get('/markets', async (c) => {
  try {
    return c.json(await getMarkets())
  } catch (err) {
    console.error('[api] Pacifica markets unavailable:', err instanceof Error ? err.message : err)
    return c.json({ error: 'Pacifica markets unavailable' }, 502)
  }
})

// GET /perps/pacifica/icons/:file — cached SVG proxy to avoid client fan-out to Pacifica.
pacificaRoutes.get('/icons/:file', async (c) => {
  const rawFile = c.req.param('file')
  const base = rawFile.replace(/\.svg$/i, '').replace(/[^A-Za-z0-9_]/g, '').toUpperCase()
  if (!base) return c.json({ error: 'Invalid icon' }, 400)

  const now = Date.now()
  const cached = iconCache.get(base)
  if (cached && cached.expiresAt > now) {
    if (cached.svg === null) return c.body(null, 404)
    return new Response(cached.svg, {
      headers: {
        'Content-Type': 'image/svg+xml; charset=utf-8',
        'Cache-Control': 'public, max-age=86400',
      },
    })
  }

  try {
    const res = await fetch(`${PACIFICA_ICON_BASE}/${encodeURIComponent(base)}.svg`)
    if (!res.ok) {
      // Negative-cache misses for an hour, not a day — see
      // ICON_NEGATIVE_CACHE_TTL_MS above; a newly listed token must not be
      // broken all day.
      iconCache.set(base, { svg: null, expiresAt: now + ICON_NEGATIVE_CACHE_TTL_MS })
      return c.body(null, 404)
    }

    const svg = await res.text()
    iconCache.set(base, { svg, expiresAt: now + ICON_CACHE_TTL_MS })
    return new Response(svg, {
      headers: {
        'Content-Type': 'image/svg+xml; charset=utf-8',
        'Cache-Control': 'public, max-age=86400',
      },
    })
  } catch (err) {
    console.error(`[api] Pacifica icon ${base} unavailable:`, err instanceof Error ? err.message : err)
    return c.body(null, 502)
  }
})
