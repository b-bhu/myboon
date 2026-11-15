/**
 * Venue-neutral mapping from chart story markers to shared chart annotations.
 *
 * Lifted verbatim from PhoenixPriceChart.tsx (memo at :321) as part of the
 * one-detail-screen refactor (#651): clustering stays in
 * market-chart.annotations.ts; this module only translates marker data.
 * Pure — safe to unit test outside React Native.
 */

import type { MarketChartAnnotation } from './market-chart.types';

/** Structural input consumed by all venues' story-marker pipelines. */
export interface ChartStoryMarker {
  /** Stable identity for this story on this candle. */
  readonly id: string;
  /** Exact candle timestamp in Unix milliseconds. */
  readonly time: number;
  readonly story: {
    readonly name: string;
    readonly latestDevelopment?: string | null;
    readonly imageUrl?: string | null;
  };
  /** Valid developments sorted newest-first for card navigation. */
  readonly events: readonly {
    readonly text?: string | null;
    readonly imageUrl?: string | null;
  }[];
}

export function chartStoryMarkersToAnnotations(
  markers: readonly ChartStoryMarker[],
): MarketChartAnnotation[] {
  return markers.map((marker) => ({
    id: marker.id,
    timeMs: marker.time,
    label: marker.events[0]?.text ?? marker.story.name,
    accessibilityLabel: `${marker.story.name}. ${marker.events[0]?.text ?? marker.story.latestDevelopment}`,
    imageUrl: marker.events[0]?.imageUrl ?? marker.story.imageUrl,
    fallbackText: '✦',
    tone: 'accent' as const,
  }));
}
