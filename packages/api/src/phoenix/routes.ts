import { Hono } from 'hono'
import { OrderFlags } from '@ellipsis-labs/rise'
import {
  asBoolean,
  asNonEmptyString,
  asRecord,
  asString,
  historyLimit,
  normalizeMarketSymbol,
  normalizeVenueSymbol,
} from './parse.js'
import { mergeMarketStats, normalizeCandle, normalizedStatus, normalizeMarket } from './market.js'
import {
  appendOptionalIntegerQuery,
  appendOptionalQuery,
  instructionBuilderResponse,
  invalidFieldsPayload,
  invalidNonNegativeIntegerFields,
  missingFieldsPayload,
  missingStringFields,
  parseCandleLimit,
  parsePositionConditionalOrderBody,
  parseSdkOrderBuilderBody,
  parseTransferBuilderInput,
  readJsonRecord,
  requireLimitPriceUsd,
} from './request.js'
import {
  buildMissingConditionalOrdersAccountIxs,
  positionConditionalTriggers,
  resolvePositionConditionalSize,
  sdkInstructionBuilderResponse,
} from './sdk.js'
import { getPhoenixTraderState } from './trader-state.js'
import type { PhoenixUpstream } from './upstream.js'
import { upstreamErrorPayload, upstreamProxyStatusCode, upstreamStatusCode } from './upstream.js'
import type { NormalizedPhoenixMarket } from './types.js'

const SUPPORTED_CANDLE_INTERVALS = new Set(['1m', '5m', '15m', '30m', '1h', '4h', '1d'])

export interface PhoenixRoutesOptions {
  /** The shared upstream: REST/WebSocket reads, caches and SDK clients (built from `PhoenixConfig`). */
  upstream: PhoenixUpstream
}

export function createPhoenixRoutes(options: PhoenixRoutesOptions): Hono {
  const { upstream } = options
  const phoenixRoutes = new Hono()

  // GET /perps/phoenix/health
  phoenixRoutes.get('/health', (c) => {
    return c.json({
      venueId: 'phoenix',
      status: 'ok',
      upstreamBase: upstream.config.apiBase,
      readOnly: false,
      executionMode: 'solana_instruction_builder',
      depositBuilderAvailable: true,
      withdrawBuilderAvailable: true,
    })
  })

  // GET /perps/phoenix/status
  phoenixRoutes.get('/status', async (c) => {
    try {
      return c.json(normalizedStatus(await upstream.getExchangeSnapshot()))
    } catch (err) {
      console.error('[api] Phoenix status unavailable:', err instanceof Error ? err.message : err)
      return c.json(upstreamErrorPayload(err, 'Phoenix status unavailable'), upstreamStatusCode(err))
    }
  })

  // GET /perps/phoenix/markets
  phoenixRoutes.get('/markets', async (c) => {
    try {
      const markets = await upstream.getRawMarkets()
      const stats = await upstream.getMarketStats(
        markets.data
          .map((market) => normalizeVenueSymbol(asString(market.symbol)))
          .filter((symbol): symbol is string => symbol !== null),
      )
      const data = markets.data
        .map((market) => normalizeMarket(market, markets.fetchedAt))
        .filter((market): market is NormalizedPhoenixMarket => market !== null)
        .map((market) => mergeMarketStats(market, stats.get(market.venueSymbol)))
        .sort((a, b) => a.baseSymbol.localeCompare(b.baseSymbol))

      return c.json(data)
    } catch (err) {
      console.error('[api] Phoenix markets unavailable:', err instanceof Error ? err.message : err)
      return c.json(upstreamErrorPayload(err, 'Phoenix markets unavailable'), upstreamStatusCode(err))
    }
  })

  // GET /perps/phoenix/markets/:symbol
  phoenixRoutes.get('/markets/:symbol', async (c) => {
    const venueSymbol = normalizeVenueSymbol(c.req.param('symbol'))
    if (!venueSymbol) return c.json({ error: 'Invalid Phoenix market symbol' }, 400)

    try {
      const result = await upstream.getMarketByVenueSymbol(venueSymbol)
      if (!result) return c.json({ error: 'Phoenix market not found' }, 404)

      const market = normalizeMarket(result.market, result.fetchedAt)
      if (!market) return c.json({ error: 'Phoenix market not found' }, 404)

      const stats = await upstream.getMarketStats([market.venueSymbol])
      return c.json(mergeMarketStats(market, stats.get(market.venueSymbol)))
    } catch (err) {
      console.error(`[api] Phoenix market ${venueSymbol} unavailable:`, err instanceof Error ? err.message : err)
      return c.json(upstreamErrorPayload(err, 'Phoenix market unavailable'), upstreamStatusCode(err))
    }
  })

  // GET /perps/phoenix/trader/:authority/state?pdaIndex=0
  phoenixRoutes.get('/trader/:authority/state', async (c) => {
    const result = await getPhoenixTraderState(
      upstream,
      asNonEmptyString(c.req.param('authority')),
      c.req.query('pdaIndex'),
    )
    return c.json(result.body, result.status)
  })

  // GET /perps/phoenix/trader/:authority/order-history?traderPdaIndex=0&limit=50
  phoenixRoutes.get('/trader/:authority/order-history', async (c) => {
    const authority = asNonEmptyString(c.req.param('authority'))
    if (!authority) return c.json({ error: 'Missing or invalid authority' }, 400)

    const params = new URLSearchParams({ limit: String(historyLimit(c.req.query('limit'))) })
    const traderPdaIndex = c.req.query('traderPdaIndex') ?? c.req.query('pdaIndex')
    const invalidPda = appendOptionalIntegerQuery(params, 'traderPdaIndex', traderPdaIndex)
    if (invalidPda) return invalidPda

    const marketSymbol = normalizeMarketSymbol(c.req.query('marketSymbol') ?? c.req.query('symbol'))
    if ((c.req.query('marketSymbol') ?? c.req.query('symbol')) && !marketSymbol) {
      return c.json({ error: 'Invalid marketSymbol', code: 'INVALID_MARKET_SYMBOL' }, 400)
    }
    if (marketSymbol) params.set('marketSymbol', marketSymbol)
    appendOptionalQuery(params, 'cursor', c.req.query('cursor'))
    appendOptionalQuery(params, 'privyId', c.req.query('privyId'))
    appendOptionalQuery(params, 'orderStatus', c.req.query('orderStatus'))

    try {
      const raw = await upstream.fetchJson<unknown>(`/trader/${encodeURIComponent(authority)}/order-history?${params.toString()}`)
      const rawRecord = asRecord(raw)
      return c.json({
        venueId: 'phoenix',
        action: 'get_order_history',
        authority,
        data: Array.isArray(rawRecord?.data) ? rawRecord.data : [],
        hasMore: asBoolean(rawRecord?.hasMore) ?? false,
        nextCursor: asString(rawRecord?.nextCursor),
        prevCursor: asString(rawRecord?.prevCursor),
        raw,
      })
    } catch (err) {
      console.error(`[api] Phoenix order history ${authority} unavailable:`, err instanceof Error ? err.message : err)
      return c.json(upstreamErrorPayload(err, 'Phoenix order history unavailable'), upstreamProxyStatusCode(err))
    }
  })

  // GET /perps/phoenix/trader/:authority/trades-history?pdaIndex=0&limit=50
  phoenixRoutes.get('/trader/:authority/trades-history', async (c) => {
    const authority = asNonEmptyString(c.req.param('authority'))
    if (!authority) return c.json({ error: 'Missing or invalid authority' }, 400)

    const params = new URLSearchParams({ limit: String(historyLimit(c.req.query('limit'))) })
    const invalidPda = appendOptionalIntegerQuery(params, 'pdaIndex', c.req.query('pdaIndex'))
    if (invalidPda) return invalidPda

    const marketSymbol = normalizeMarketSymbol(c.req.query('marketSymbol') ?? c.req.query('symbol'))
    if ((c.req.query('marketSymbol') ?? c.req.query('symbol')) && !marketSymbol) {
      return c.json({ error: 'Invalid marketSymbol', code: 'INVALID_MARKET_SYMBOL' }, 400)
    }
    if (marketSymbol) params.set('marketSymbol', marketSymbol)
    appendOptionalQuery(params, 'cursor', c.req.query('cursor'))

    try {
      const raw = await upstream.fetchJson<unknown>(`/trader/${encodeURIComponent(authority)}/trades-history?${params.toString()}`)
      const rawRecord = asRecord(raw)
      return c.json({
        venueId: 'phoenix',
        action: 'get_trade_history',
        authority,
        data: Array.isArray(rawRecord?.data) ? rawRecord.data : [],
        hasMore: asBoolean(rawRecord?.hasMore) ?? false,
        nextCursor: asString(rawRecord?.nextCursor),
        prevCursor: asString(rawRecord?.prevCursor),
        raw,
      })
    } catch (err) {
      console.error(`[api] Phoenix trade history ${authority} unavailable:`, err instanceof Error ? err.message : err)
      return c.json(upstreamErrorPayload(err, 'Phoenix trade history unavailable'), upstreamProxyStatusCode(err))
    }
  })

  // GET /perps/phoenix/trader/:authority/collateral-history?pdaIndex=0&limit=50
  phoenixRoutes.get('/trader/:authority/collateral-history', async (c) => {
    const authority = asNonEmptyString(c.req.param('authority'))
    if (!authority) return c.json({ error: 'Missing or invalid authority' }, 400)

    const params = new URLSearchParams({ limit: String(historyLimit(c.req.query('limit'))) })
    const invalidPda = appendOptionalIntegerQuery(params, 'pdaIndex', c.req.query('pdaIndex'))
    if (invalidPda) return invalidPda

    appendOptionalQuery(params, 'cursor', c.req.query('cursor'))
    appendOptionalQuery(params, 'nextCursor', c.req.query('nextCursor'))
    appendOptionalQuery(params, 'prevCursor', c.req.query('prevCursor'))

    try {
      const raw = await upstream.fetchJson<unknown>(`/trader/${encodeURIComponent(authority)}/collateral-history?${params.toString()}`)
      const rawRecord = asRecord(raw)
      return c.json({
        venueId: 'phoenix',
        action: 'get_collateral_history',
        authority,
        data: Array.isArray(rawRecord?.data) ? rawRecord.data : [],
        hasMore: asBoolean(rawRecord?.hasMore) ?? false,
        nextCursor: asString(rawRecord?.nextCursor),
        prevCursor: asString(rawRecord?.prevCursor),
        raw,
      })
    } catch (err) {
      console.error(`[api] Phoenix collateral history ${authority} unavailable:`, err instanceof Error ? err.message : err)
      return c.json(upstreamErrorPayload(err, 'Phoenix collateral history unavailable'), upstreamProxyStatusCode(err))
    }
  })

  // POST /perps/phoenix/invite/activate
  phoenixRoutes.post('/invite/activate', async (c) => {
    const parsed = await readJsonRecord(c)
    if ('response' in parsed) return parsed.response

    const missing = missingStringFields(parsed.body, ['authority', 'code'])
    if (missing.length > 0) return c.json(missingFieldsPayload(missing), 400)

    try {
      const raw = await upstream.fetchJson<unknown>('/v1/invite/activate', { method: 'POST', body: parsed.body })
      const rawRecord = asRecord(raw)
      return c.json({
        venueId: 'phoenix',
        action: 'activate_invite',
        authority: asNonEmptyString(parsed.body.authority),
        traderPda: asString(rawRecord?.trader_pda),
        raw,
      })
    } catch (err) {
      console.error('[api] Phoenix invite activation unavailable:', err instanceof Error ? err.message : err)
      return c.json(upstreamErrorPayload(err, 'Phoenix invite activation unavailable'), upstreamProxyStatusCode(err))
    }
  })

  // POST /perps/phoenix/invite/activate-with-referral
  phoenixRoutes.post('/invite/activate-with-referral', async (c) => {
    const parsed = await readJsonRecord(c)
    if ('response' in parsed) return parsed.response

    const missing = missingStringFields(parsed.body, ['authority', 'referral_code'])
    if (missing.length > 0) return c.json(missingFieldsPayload(missing), 400)

    try {
      const raw = await upstream.fetchJson<unknown>('/v1/invite/activate-with-referral', { method: 'POST', body: parsed.body })
      const rawRecord = asRecord(raw)
      return c.json({
        venueId: 'phoenix',
        action: 'activate_referral',
        authority: asNonEmptyString(parsed.body.authority),
        traderPda: asString(rawRecord?.trader_pda),
        raw,
      })
    } catch (err) {
      console.error('[api] Phoenix referral activation unavailable:', err instanceof Error ? err.message : err)
      return c.json(upstreamErrorPayload(err, 'Phoenix referral activation unavailable'), upstreamProxyStatusCode(err))
    }
  })

  // POST /perps/phoenix/tx/market-order
  phoenixRoutes.post('/tx/market-order', async (c) => {
    const parsed = await readJsonRecord(c)
    if ('response' in parsed) return parsed.response

    const builder = parseSdkOrderBuilderBody(parsed.body, 'market')
    if ('response' in builder) return builder.response

    const useRawClient = builder.orderFlags !== OrderFlags.None
    const endpoint = useRawClient ? 'sdk:ixs.buildPlaceMarketOrder:raw' : 'sdk:ixs.buildPlaceMarketOrder'
    try {
      const client = useRawClient ? upstream.getRawSdkClient() : upstream.getSdkClient()
      await client.exchange.ready()
      const orderPacket = await client.orderPackets.buildMarketOrderPacket({
        symbol: builder.symbol,
        side: builder.side,
        baseUnits: builder.baseUnits,
        priceLimitUsd: builder.priceLimitUsd,
        orderFlags: builder.orderFlags,
      })
      const raw = await client.ixs.buildPlaceMarketOrder({
        authority: builder.authority,
        positionAuthority: builder.positionAuthority,
        symbol: builder.symbol,
        orderPacket,
        traderPdaIndex: builder.traderPdaIndex,
        traderSubaccountIndex: builder.traderSubaccountIndex,
      })
      return c.json(sdkInstructionBuilderResponse('place_market_order', endpoint, raw))
    } catch (err) {
      console.error('[api] Phoenix market order builder unavailable:', err instanceof Error ? err.message : err)
      return c.json(upstreamErrorPayload(err, 'Phoenix market order builder unavailable'), upstreamProxyStatusCode(err))
    }
  })

  // POST /perps/phoenix/tx/limit-order
  phoenixRoutes.post('/tx/limit-order', async (c) => {
    const parsed = await readJsonRecord(c)
    if ('response' in parsed) return parsed.response

    const builder = parseSdkOrderBuilderBody(parsed.body, 'limit')
    if ('response' in builder) return builder.response

    const useRawClient = builder.orderFlags !== OrderFlags.None
    const endpoint = useRawClient ? 'sdk:ixs.buildPlaceLimitOrder:raw' : 'sdk:ixs.buildPlaceLimitOrder'
    try {
      const client = useRawClient ? upstream.getRawSdkClient() : upstream.getSdkClient()
      await client.exchange.ready()
      const orderPacket = await client.orderPackets.buildLimitOrderPacket({
        symbol: builder.symbol,
        side: builder.side,
        priceUsd: requireLimitPriceUsd(builder.priceUsd),
        baseUnits: builder.baseUnits,
        orderFlags: builder.orderFlags,
      })
      const raw = await client.ixs.buildPlaceLimitOrder({
        authority: builder.authority,
        positionAuthority: builder.positionAuthority,
        symbol: builder.symbol,
        orderPacket,
        traderPdaIndex: builder.traderPdaIndex,
        traderSubaccountIndex: builder.traderSubaccountIndex,
      })
      return c.json(sdkInstructionBuilderResponse('place_limit_order', endpoint, raw))
    } catch (err) {
      console.error('[api] Phoenix limit order builder unavailable:', err instanceof Error ? err.message : err)
      return c.json(upstreamErrorPayload(err, 'Phoenix limit order builder unavailable'), upstreamProxyStatusCode(err))
    }
  })

  // POST /perps/phoenix/tx/cancel-conditional-order
  phoenixRoutes.post('/tx/cancel-conditional-order', async (c) => {
    const parsed = await readJsonRecord(c)
    if ('response' in parsed) return parsed.response

    const missing = missingStringFields(parsed.body, ['authority', 'symbol', 'executionDirection'])
    if (missing.length > 0) return c.json(missingFieldsPayload(missing), 400)

    const invalid = invalidNonNegativeIntegerFields(parsed.body, ['traderPdaIndex', 'conditionalOrderIndex'])
    if (invalid.length > 0) return c.json(invalidFieldsPayload(invalid), 400)

    const endpoint = '/v1/ix/cancel-conditional-order'
    try {
      const raw = await upstream.fetchJson<unknown>(endpoint, { method: 'POST', body: parsed.body })
      return c.json(instructionBuilderResponse('cancel_conditional_order', endpoint, raw))
    } catch (err) {
      console.error('[api] Phoenix conditional cancel builder unavailable:', err instanceof Error ? err.message : err)
      return c.json(upstreamErrorPayload(err, 'Phoenix conditional cancel builder unavailable'), upstreamProxyStatusCode(err))
    }
  })

  // POST /perps/phoenix/tx/position-conditional-order
  phoenixRoutes.post('/tx/position-conditional-order', async (c) => {
    const parsed = await readJsonRecord(c)
    if ('response' in parsed) return parsed.response

    const builder = parsePositionConditionalOrderBody(parsed.body)
    if ('response' in builder) return builder.response

    const endpoint = 'sdk:ixs.buildPlacePositionConditionalOrder:raw'
    try {
      const client = upstream.getRawSdkClient()
      const { greaterTriggerOrder, lessTriggerOrder } = await positionConditionalTriggers(
        client,
        builder.symbol,
        builder.positionSide,
        builder.takeProfitPriceUsd,
        builder.stopLossPriceUsd,
      )
      const size = await resolvePositionConditionalSize(client, builder.symbol, builder)
      const setupIxs = await buildMissingConditionalOrdersAccountIxs(client, builder)
      const placeIx = await client.ixs.buildPlacePositionConditionalOrder({
        authority: builder.authority,
        positionAuthority: builder.positionAuthority,
        symbol: builder.symbol,
        greaterTriggerOrder,
        lessTriggerOrder,
        sizeBaseLots: size.sizeBaseLots,
        sizePercent: size.sizePercent,
        traderPdaIndex: builder.traderPdaIndex,
        traderSubaccountIndex: builder.traderSubaccountIndex,
      })
      const raw = setupIxs.length > 0 ? [...setupIxs, placeIx] : placeIx
      return c.json(sdkInstructionBuilderResponse('place_position_conditional_order', endpoint, raw))
    } catch (err) {
      console.error('[api] Phoenix position conditional builder unavailable:', err instanceof Error ? err.message : err)
      return c.json(upstreamErrorPayload(err, 'Phoenix position conditional builder unavailable'), upstreamProxyStatusCode(err))
    }
  })

  // POST /perps/phoenix/tx/deposit
  phoenixRoutes.post('/tx/deposit', async (c) => {
    const parsed = await readJsonRecord(c)
    if ('response' in parsed) return parsed.response

    const builder = parseTransferBuilderInput(parsed.body)
    if (builder.response) return builder.response

    try {
      const raw = await upstream.getSdkClient().ixs.buildDepositIxs(builder.input as never)
      return c.json(sdkInstructionBuilderResponse('deposit', '/tx/deposit', raw))
    } catch (err) {
      console.error('[api] Phoenix deposit builder unavailable:', err instanceof Error ? err.message : err)
      return c.json(upstreamErrorPayload(err, 'Phoenix deposit builder unavailable'), upstreamProxyStatusCode(err))
    }
  })

  // POST /perps/phoenix/tx/withdraw
  phoenixRoutes.post('/tx/withdraw', async (c) => {
    const parsed = await readJsonRecord(c)
    if ('response' in parsed) return parsed.response

    const builder = parseTransferBuilderInput(parsed.body)
    if (builder.response) return builder.response

    try {
      const raw = await upstream.getSdkClient().ixs.buildWithdrawIxs(builder.input as never)
      return c.json(sdkInstructionBuilderResponse('withdraw', '/tx/withdraw', raw))
    } catch (err) {
      console.error('[api] Phoenix withdraw builder unavailable:', err instanceof Error ? err.message : err)
      return c.json(upstreamErrorPayload(err, 'Phoenix withdraw builder unavailable'), upstreamProxyStatusCode(err))
    }
  })

  // GET /perps/phoenix/candles?symbol=&interval=&count=&startTime=&endTime=
  phoenixRoutes.get('/candles', async (c) => {
    const venueSymbol = normalizeVenueSymbol(c.req.query('symbol'))
    if (!venueSymbol) return c.json({ error: 'Missing or invalid symbol' }, 400)

    const interval = c.req.query('interval') ?? '1h'
    if (!SUPPORTED_CANDLE_INTERVALS.has(interval)) {
      return c.json({
        error: 'Unsupported Phoenix candle interval',
        code: 'UNSUPPORTED_INTERVAL',
        supportedIntervals: [...SUPPORTED_CANDLE_INTERVALS],
      }, 400)
    }

    try {
      const knownMarket = await upstream.getMarketByVenueSymbol(venueSymbol)
      if (!knownMarket) return c.json({ error: 'Phoenix market not found' }, 404)

      const limit = parseCandleLimit(c.req.query('count') ?? c.req.query('limit'), upstream.config.maxCandleLimit)
      const params = new URLSearchParams({ symbol: venueSymbol, timeframe: interval, limit: String(limit) })
      appendOptionalQuery(params, 'startTime', c.req.query('startTime'))
      appendOptionalQuery(params, 'endTime', c.req.query('endTime'))
      appendOptionalQuery(params, 'enableExternalSource', c.req.query('enableExternalSource'))

      const cacheKey = params.toString()
      const raw = await upstream.getCandles(cacheKey)
      const candles = raw.data.map(normalizeCandle).filter((candle): candle is NonNullable<ReturnType<typeof normalizeCandle>> => candle !== null)
      return c.json(candles)
    } catch (err) {
      console.error(`[api] Phoenix candles ${venueSymbol} unavailable:`, err instanceof Error ? err.message : err)
      return c.json(upstreamErrorPayload(err, 'Phoenix candles unavailable'), upstreamStatusCode(err))
    }
  })

  return phoenixRoutes
}
