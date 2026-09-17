import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PhoenixMarket } from './phoenix.api';
import {
  applyPhoenixLiveMarketStats,
  buildPhoenixLiveSubscriptionMessages,
  parsePhoenixLiveMessage,
  phoenixReconnectDelayMs,
  type PhoenixLiveMarketStats,
} from './phoenix.live';

describe('Phoenix live protocol', () => {
  it('builds anonymous candle and market-stat subscriptions for the venue symbol', () => {
    assert.deepEqual(buildPhoenixLiveSubscriptionMessages('subscribe', 'btc-perp', '1h'), [
      {
        type: 'subscribe',
        subscription: { channel: 'candles', symbol: 'BTC', timeframe: '1h' },
      },
      {
        type: 'subscribe',
        subscription: { channel: 'marketStats', symbol: 'BTC' },
      },
    ]);
  });

  it('parses truthful Phoenix OHLCV candle messages', () => {
    const update = parsePhoenixLiveMessage(JSON.stringify({
      channel: 'candle',
      symbol: 'BTC',
      timeframe: '1h',
      candle: {
        time: 1_789_646_400,
        open: 76_492,
        high: 76_999,
        low: 76_443,
        close: 76_952,
        volume: 0.6849,
        volumeQuote: 52_585.85,
        tradeCount: 105,
      },
    }), 1234);

    assert.equal(update?.kind, 'candle');
    if (!update || update.kind !== 'candle') return;
    assert.equal(update.receivedAt, 1234);
    assert.equal(update.candle.close, 76_952);
    assert.equal(update.candle.tradeCount, 105);
    assert.equal(update.candle.externalSource, 'phoenix_ws');
  });

  it('parses live market statistics and normalizes timestamps', () => {
    const update = parsePhoenixLiveMessage({
      channel: 'marketStats',
      symbol: 'SOL',
      timestamp: 1_789_647_516,
      openInterest: 52_000,
      markPrice: 210,
      oraclePrice: 209.8,
      prevDayMarkPrice: 200,
      dayVolumeUsd: 8_000_000,
      dayVolumeBase: 39_000,
      currentFundingRate: 0.001,
      eightHourFundingRate: 0.008,
      annualizedFundingRate: 8.76,
    }, 5678);

    assert.equal(update?.kind, 'marketStats');
    if (!update || update.kind !== 'marketStats') return;
    assert.equal(update.timestampMs, 1_789_647_516_000);
    assert.equal(update.markPrice, 210);
    assert.equal(update.receivedAt, 5678);
  });

  it('rejects acknowledgements and malformed price data', () => {
    assert.equal(parsePhoenixLiveMessage({ channel: 'subscriptionStatus' }), null);
    assert.equal(parsePhoenixLiveMessage({
      channel: 'marketStats',
      symbol: 'BTC',
      timestamp: 1,
      markPrice: Number.NaN,
    }), null);
  });
});

describe('Phoenix live state projection', () => {
  it('merges live market statistics without changing venue identity', () => {
    const market = phoenixMarket();
    const stats: PhoenixLiveMarketStats = {
      kind: 'marketStats',
      symbol: 'BTC',
      timestampMs: 1_789_647_516_000,
      markPrice: 110,
      oraclePrice: 109,
      previousDayMarkPrice: 100,
      openInterestBase: 25,
      volume24hUsd: 4_500_000,
      volume24hBase: 42_000,
      fundingRate: 0.002,
      receivedAt: 1_789_647_516_000,
    };

    const updated = applyPhoenixLiveMarketStats(market, stats);

    assert.equal(updated.symbol, 'BTC-PERP');
    assert.equal(updated.markPrice, 110);
    assert.equal(updated.oraclePrice, 109);
    assert.equal(updated.change24h, 10);
    assert.equal(updated.openInterest, 2_750);
    assert.equal(updated.volume24h, 4_500_000);
    assert.equal(updated.dataFreshness, 'live');
  });

  it('uses capped exponential reconnect backoff with bounded jitter', () => {
    assert.equal(phoenixReconnectDelayMs(0, 0.5), 1_000);
    assert.equal(phoenixReconnectDelayMs(3, 0.5), 8_000);
    assert.equal(phoenixReconnectDelayMs(20, 0.5), 30_000);
    assert.equal(phoenixReconnectDelayMs(0, 0), 800);
    assert.equal(phoenixReconnectDelayMs(0, 1), 1_200);
  });
});

function phoenixMarket(): PhoenixMarket {
  return {
    venueId: 'phoenix',
    symbol: 'BTC-PERP',
    venueSymbol: 'BTC',
    baseSymbol: 'BTC',
    displayName: 'BTC Perpetual',
    quoteSymbol: 'USDC',
    iconPath: null,
    status: 'active',
    tradeable: true,
    maxLeverage: 20,
    tickSize: '1',
    lotSize: '0.0001',
    minOrderSize: '0.0001',
    markPrice: 100,
    oraclePrice: 100,
    midPrice: 100,
    fundingRate: 0,
    openInterest: 1_000,
    volume24h: 2_000_000,
    change24h: 0,
    dataFreshness: 'snapshot',
    dataFreshnessReason: null,
    configFetchedAt: null,
    precision: {
      tickSize: '1',
      rawTickSize: 1,
      baseLotsDecimals: 4,
    },
    limits: {
      openInterestCapBaseLots: null,
      maxLiquidationSizeBaseLots: null,
      leverageTiers: [],
    },
    fees: {
      makerFee: 0,
      takerFee: 0.001,
    },
    funding: {
      fundingIntervalSeconds: 3_600,
      fundingPeriodSeconds: 3_600,
      maxFundingRatePerInterval: null,
      maxFundingRatePerIntervalPercentage: null,
    },
    metadata: {
      assetId: null,
      marketPubkey: null,
      splinePubkey: null,
      isolatedOnly: false,
    },
  };
}
