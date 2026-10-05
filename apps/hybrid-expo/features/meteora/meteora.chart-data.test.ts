import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MeteoraOhlcvQuery, MeteoraOhlcvSeries, MeteoraResult } from '@myboon/shared/meteora';

import { loadMeteoraChartData } from './meteora.chart-data';

const response: MeteoraResult<MeteoraOhlcvSeries> = {
  data: { timeframe: '1h', startTime: 0, endTime: 3600, candles: [] },
  freshness: { state: 'live', source: 'meteora_data_api', servedAt: '', ageMs: 0 },
};

test('range rejection falls back once to API-selected bounds and returns the actual response', async () => {
  const calls: MeteoraOhlcvQuery[] = [];
  const client = {
    async getOhlcv(_pool: string, query: MeteoraOhlcvQuery = {}) {
      calls.push(query);
      if (calls.length === 1) throw Object.assign(new Error('{"message":"time range too large"}'), { status: 400 });
      return response;
    },
  };
  const result = await loadMeteoraChartData(client, 'pool', { interval: '1h', intervalSeconds: 3600 }, 1_700_000_000_000);
  assert.equal(result, response);
  assert.equal(calls[0].endTime! % 3600, 0);
  assert.deepEqual(calls[1], { timeframe: '1h' });
  assert.equal(calls.length, 2);
});

test('network and unrelated API errors remain errors rather than silently requesting different data', async () => {
  for (const error of [new Error('Network request failed'), Object.assign(new Error('Pool unavailable'), { status: 400 })]) {
    let calls = 0;
    const client = {
      async getOhlcv() { calls += 1; throw error; },
    };
    await assert.rejects(() => loadMeteoraChartData(client, 'pool', { interval: '1h', intervalSeconds: 3600 }), error);
    assert.equal(calls, 1);
  }
});
