import type { PhoenixChartEventInput } from '@/features/perps/phoenix.chart-events';

/**
 * Demo annotations intentionally use presentation positions instead of their
 * clustered source timestamps. This keeps all ten Bitcoin memories legible on
 * every BTC chart timeframe while preserving the real event time in context.
 */
export const BTC_DEMO_EVENTS: readonly PhoenixChartEventInput[] = [
  {
    text: 'Bitcoin clears $80K after a 27.5% rally from its August low',
    eventAt: '2026-08-24T19:34:17+00:00',
    imageUrl: 'https://assets.coingecko.com/articles/images/108234477/large/open-uri20260824-1-vxumx9.?1787600511',
    chartPosition: 0.07,
  },
  {
    text: 'Bitcoin posts its strongest three-day gain since 2023',
    eventAt: '2026-08-24T19:20:31+00:00',
    imageUrl: 'https://assets.coingecko.com/articles/images/108234377/large/open-uri20260824-1-d1n665.?1787599299',
    chartPosition: 0.16,
  },
  {
    text: 'Large BTC and ETH shorts show a $6.88M unrealized loss',
    eventAt: '2026-08-24T16:23:25+00:00',
    imageUrl: 'https://assets.coingecko.com/articles/images/108233444/large/data.?1787588605',
    chartPosition: 0.25,
  },
  {
    text: 'Crypto-linked stocks rally as Bitcoin approaches $80K',
    eventAt: '2026-08-24T16:11:54+00:00',
    imageUrl: 'https://assets.coingecko.com/articles/images/108233374/large/data.?1787587914',
    chartPosition: 0.35,
  },
  {
    text: 'Bitcoin trades above $80K for the first time in 101 days',
    eventAt: '2026-08-24T15:43:08+00:00',
    imageUrl: 'https://assets.coingecko.com/articles/images/108233166/large/data.?1787586188',
    chartPosition: 0.45,
  },
  {
    text: 'Bitcoin enters high-level consolidation above $79K',
    eventAt: '2026-08-24T15:39:09+00:00',
    imageUrl: 'https://assets.coingecko.com/articles/images/108233125/large/open-uri20260824-1-dnpmsw.?1787586022',
    chartPosition: 0.56,
  },
  {
    text: 'IBIT call volume reaches a record 1.58M contracts',
    eventAt: '2026-08-24T14:41:34+00:00',
    imageUrl: 'https://assets.coingecko.com/articles/images/108232950/large/open-uri20260824-1-1iwdhv.?1787583198',
    chartPosition: 0.67,
  },
  {
    text: 'Bitcoin breakout settles into a $77K–$79K range',
    eventAt: '2026-08-24T14:33:22+00:00',
    imageUrl: 'https://assets.coingecko.com/articles/images/108232895/large/open-uri20260824-1-g7ym34.?1787582451',
    chartPosition: 0.77,
  },
  {
    text: 'Bitcoin crosses $79K during the 12:00 UTC hour',
    eventAt: '2026-08-24T12:50:54+00:00',
    imageUrl: 'https://assets.coingecko.com/articles/images/108232096/large/open-uri20260824-1-oqc9tk.?1787575921',
    chartPosition: 0.87,
  },
  {
    text: 'Whale opens a $71.8M BTC and ETH long on Hyperliquid',
    eventAt: '2026-08-24T12:25:17+00:00',
    imageUrl: 'https://assets.coingecko.com/articles/images/108231874/large/data.?1787574317',
    chartPosition: 0.96,
  },
] as const;

export function isBitcoinPerpSymbol(symbol: string): boolean {
  return symbol.trim().toUpperCase().replace(/-PERP$/, '') === 'BTC';
}
