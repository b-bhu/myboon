import assert from 'node:assert/strict'
import type { HyperliquidCandlesResponse, MarketCandle, StoryMarket } from './index.js'

// Compile-time checks run under `pnpm --filter @myboon/shared typecheck`;
// `tsx` only strips types, so the runtime asserts below cover the fixtures.

const priced: StoryMarket = {
  symbol: 'xyz:CL',
  displaySymbol: 'WTI',
  displayName: 'WTI crude oil',
  rank: 1,
  price: 82.54,
  change24hPct: -1.25,
  asOf: '2026-11-20T10:30:00.000Z',
}

const unpriced: StoryMarket = {
  symbol: 'BTC',
  displaySymbol: 'BTC',
  displayName: 'Bitcoin',
  rank: 2,
  price: null,
  change24hPct: null,
  asOf: null,
}

// rank is 1, 2 or 3.
// @ts-expect-error rank must be 1, 2 or 3
const badRank: StoryMarket = { ...priced, rank: 4 }
// @ts-expect-error price is a number or null
const stringPrice: StoryMarket = { ...priced, price: '82.54' }
// @ts-expect-error change24hPct is a number or null
const booleanChange: StoryMarket = { ...priced, change24hPct: true }
// @ts-expect-error asOf is a string or null
const numberAsOf: StoryMarket = { ...priced, asOf: 42 }
// @ts-expect-error displaySymbol is a string
const numberDisplaySymbol: StoryMarket = { ...unpriced, displaySymbol: 7 }
void [badRank, stringPrice, booleanChange, numberAsOf, numberDisplaySymbol]

// A required field cannot be dropped.
// @ts-expect-error `symbol` is required
const missingSymbol: StoryMarket = { ...priced, symbol: undefined }
void missingSymbol

// A story with no links sends an empty markets list.
const emptyMarkets: StoryMarket[] = []
void emptyMarkets

const candle: MarketCandle = {
  timeMs: 1763632800000,
  open: 63830.5,
  high: 63948,
  low: 63753,
  close: 63760,
  volume: 584.75741,
}
const nullVolumeCandle: MarketCandle = { ...candle, volume: null }
// @ts-expect-error volume is required (nullable, not optional)
const missingVolume: MarketCandle = { timeMs: 1, open: 1, high: 1, low: 1, close: 1 }
void [candle, nullVolumeCandle, missingVolume]

const response: HyperliquidCandlesResponse = {
  symbol: 'xyz:CL',
  interval: '1h',
  candles: [candle, nullVolumeCandle],
}
// @ts-expect-error candles is required
const missingCandles: HyperliquidCandlesResponse = { symbol: 'xyz:CL', interval: '1h' }
void [response, missingCandles]

function testDocumentedFieldsOnly(): void {
  assert.deepEqual(Object.keys(priced).sort(), [
    'asOf', 'change24hPct', 'displayName', 'displaySymbol', 'price', 'rank', 'symbol',
  ])
  assert.deepEqual(Object.keys(unpriced).sort(), [
    'asOf', 'change24hPct', 'displayName', 'displaySymbol', 'price', 'rank', 'symbol',
  ])
  assert.deepEqual(Object.keys(candle).sort(), ['close', 'high', 'low', 'open', 'timeMs', 'volume'])
  assert.deepEqual(Object.keys(response).sort(), ['candles', 'interval', 'symbol'])
  assert.equal(nullVolumeCandle.volume, null)
  assert.equal(Array.isArray(emptyMarkets) && emptyMarkets.length, 0)
}

testDocumentedFieldsOnly()

console.log('Stories market shared type tests passed')
