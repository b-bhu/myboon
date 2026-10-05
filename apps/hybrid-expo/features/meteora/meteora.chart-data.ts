import type { MeteoraDataApiClient, MeteoraTimeframe } from '@myboon/shared/meteora';

/** Fetch pool candles; let the API choose its range if explicit bounds are rejected. */
export async function loadMeteoraChartData(
  client: Pick<MeteoraDataApiClient, 'getOhlcv'>,
  poolAddress: string,
  timeframe: { interval: MeteoraTimeframe; intervalSeconds: number },
  nowMs = Date.now(),
) {
  const endTime = Math.floor(nowMs / 1000 / timeframe.intervalSeconds) * timeframe.intervalSeconds;
  try {
    return await client.getOhlcv(poolAddress, {
      timeframe: timeframe.interval,
      startTime: endTime - timeframe.intervalSeconds * 72,
      endTime,
    });
  } catch (error) {
    if (!(error instanceof Error) || !('status' in error) || error.status !== 400
      || !/time range|start_time|end_time/i.test(error.message)) throw error;
    // API-selected bounds also avoid depending on the phone's clock.
    return client.getOhlcv(poolAddress, { timeframe: timeframe.interval });
  }
}
