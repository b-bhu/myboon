import type { HeatmapToken } from './token-heatmap.types';

export type HeatmapTile = { token: HeatmapToken; x: number; y: number; width: number; height: number };

// Binary treemap: each split preserves the exact share of the interval's USD volume.
// Scaling weights by the largest token avoids overflow without changing their ratios.
export function layoutVolumeTreemap(tokens: readonly HeatmapToken[], width: number, height: number): HeatmapTile[] {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return [];
  const valid = tokens.filter((token) => Number.isFinite(token.volumeUsd) && token.volumeUsd > 0)
    .sort((a, b) => b.volumeUsd - a.volumeUsd || a.address.localeCompare(b.address));
  if (!valid.length) return [];
  const max = valid[0]!.volumeUsd;
  const rows = valid.map((token) => ({ token, weight: token.volumeUsd / max }));
  const tiles: HeatmapTile[] = [];
  function partition(items: typeof rows, x: number, y: number, w: number, h: number) {
    if (items.length === 1) {
      tiles.push({ token: items[0]!.token, x, y, width: w, height: h });
      return;
    }
    const total = items.reduce((sum, item) => sum + item.weight, 0);
    let split = 1;
    let left = items[0]!.weight;
    let accumulated = left;
    let distance = Math.abs(total / 2 - accumulated);
    for (let index = 1; index < items.length - 1; index += 1) {
      accumulated += items[index]!.weight;
      const nextDistance = Math.abs(total / 2 - accumulated);
      if (nextDistance < distance) { split = index + 1; left = accumulated; distance = nextDistance; }
    }
    const fraction = left / total;
    if (w >= h) {
      const cut = w * fraction;
      partition(items.slice(0, split), x, y, cut, h);
      partition(items.slice(split), x + cut, y, w - cut, h);
    } else {
      const cut = h * fraction;
      partition(items.slice(0, split), x, y, w, cut);
      partition(items.slice(split), x, y + cut, w, h - cut);
    }
  }
  partition(rows, 0, 0, width, height);
  return tiles;
}

export function heatmapTone(change: number | null): 'up' | 'down' | 'neutral' {
  return change === null || !Number.isFinite(change) || change === 0 ? 'neutral' : change > 0 ? 'up' : 'down';
}

export function heatmapColor(change: number | null): string {
  const tone = heatmapTone(change);
  if (tone === 'neutral') return '#284751';
  const index = Math.min(3, Math.floor(Math.abs(change!) / 2));
  return (tone === 'up' ? ['#185C44', '#196B48', '#19774B', '#18864E'] : ['#662A36', '#7B2B3B', '#923044', '#AA354C'])[index]!;
}

export function formatHeatmapChange(change: number | null): string {
  if (change === null || !Number.isFinite(change)) return 'Unavailable';
  const sign = change > 0 ? '+' : change < 0 ? '−' : '';
  const value = change !== 0 && Math.abs(change) < 0.01 ? '<0.01' : Math.abs(change).toFixed(2);
  return `${sign}${value}%`;
}
