import type { MarketCandle } from '@/features/charts/market-chart.types';

export function buildMarketChartAccessibilityValue(
  candle: MarketCandle | null,
  formatPrice: (value: number) => string,
  formatTime: (value: number) => string,
  formatVolume?: (value: number) => string,
): string | null {
  if (!candle) return null;

  const parts = [
    formatTime(candle.timeMs),
    `open ${formatPrice(candle.open)}`,
    `high ${formatPrice(candle.high)}`,
    `low ${formatPrice(candle.low)}`,
    `close ${formatPrice(candle.close)}`,
  ];

  if (candle.volume !== null && candle.volume !== undefined) {
    const volume = formatVolume
      ? formatVolume(candle.volume)
      : String(candle.volume);
    parts.push(`volume ${volume}`);
  }
  return parts.join(', ');
}
