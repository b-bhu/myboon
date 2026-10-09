export const HEATMAP_INTERVALS = ['5m', '1h', '6h', '24h'] as const;
export type HeatmapInterval = typeof HEATMAP_INTERVALS[number];

export type HeatmapToken = {
  address: string;
  symbol: string;
  name: string;
  priceUsd: number | null;
  volumeUsd: number;
  priceChangePct: number | null;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
};

export type TokenHeatmapResult = {
  chain: 'solana';
  interval: HeatmapInterval;
  limit: 20;
  source: 'jupiter';
  status: 'ready' | 'partial' | 'stale' | 'unavailable';
  tokens: HeatmapToken[];
  fetchedAt: string | null;
  nextRefreshAt: string | null;
  stale: boolean;
  partial: boolean;
  error?: { code: string; retryable: boolean; message: string };
};
