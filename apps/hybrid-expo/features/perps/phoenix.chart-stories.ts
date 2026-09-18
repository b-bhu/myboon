import type { StoryEvent, StorySummary } from '@/features/feed/feed.types';

export const PHOENIX_CHART_STORY_PAGE_SIZE = 50;

/** Explicit product mapping until Story actions support every market asset. */
export function phoenixStorySlugForSymbol(symbol: string): string | null {
  const baseSymbol = symbol.trim().toUpperCase().replace(/-PERP$/, '');
  return baseSymbol === 'BTC' ? 'bitcoin' : null;
}

export interface PhoenixChartStoryMarker {
  /** Stable identity for this Story on this candle. */
  readonly id: string;
  /** Index into the candle list supplied to the mapper. */
  readonly candleIndex: number;
  /** Exact candle timestamp in Unix milliseconds. */
  readonly time: number;
  readonly price: number;
  readonly story: StorySummary;
  /** Valid developments sorted newest-first for card navigation. */
  readonly events: readonly StoryEvent[];
}

interface PhoenixChartCandleInput {
  readonly time: number;
  readonly close: number;
}

interface ValidCandle extends PhoenixChartCandleInput {
  readonly index: number;
  readonly timeMs: number;
}

/**
 * Projects a product Story's developments onto their candle intervals.
 *
 * Developments attached to the same candle share one marker and can be cycled
 * from its detail card. Different candles always receive different markers.
 * This preserves the Story timeline without positioning bubbles at arbitrary
 * sub-candle timestamps.
 */
export function mapPhoenixStoryToChartMarkers(
  candles: readonly PhoenixChartCandleInput[],
  story: StorySummary,
  events: readonly StoryEvent[],
): PhoenixChartStoryMarker[] {
  const validCandles = candles.flatMap((candle, index): ValidCandle[] => {
    if (!candle || !Number.isFinite(candle.time) || !Number.isFinite(candle.close)) return [];
    const timeMs = normalizeEpoch(candle.time);
    if (!Number.isFinite(timeMs)) return [];
    return [{ ...candle, index, timeMs }];
  }).sort((left, right) => left.timeMs - right.timeMs || left.index - right.index);

  if (validCandles.length === 0) return [];

  const validEvents = events
    .filter((event) => event.text.trim().length > 0 && Number.isFinite(Date.parse(event.eventAt)))
    .slice()
    .sort((left, right) => Date.parse(right.eventAt) - Date.parse(left.eventAt));
  const eventsByCandle = new Map<number, StoryEvent[]>();

  validEvents.forEach((event) => {
    const eventTime = Date.parse(event.eventAt);
    if (eventTime < validCandles[0].timeMs) return;
    const anchor = candleAtOrBefore(validCandles, eventTime);
    const bucket = eventsByCandle.get(anchor.index);
    if (bucket) bucket.push(event);
    else eventsByCandle.set(anchor.index, [event]);
  });

  return Array.from(eventsByCandle.entries())
    .sort(([leftIndex], [rightIndex]) => leftIndex - rightIndex)
    .map(([candleIndex, candleEvents]) => {
      const anchor = validCandles.find((candle) => candle.index === candleIndex)!;
      return {
        id: `phoenix-chart-story-${story.storySlug}-${anchor.timeMs}`,
        candleIndex,
        time: anchor.timeMs,
        price: anchor.close,
        story,
        events: candleEvents,
      };
    });
}

function candleAtOrBefore(
  candles: readonly ValidCandle[],
  eventTime: number,
): ValidCandle {
  let anchor = candles[0];
  for (const candle of candles) {
    if (candle.timeMs > eventTime) break;
    anchor = candle;
  }
  return anchor;
}

function normalizeEpoch(value: number): number {
  return Math.abs(value) < 100_000_000_000 ? value * 1000 : value;
}
