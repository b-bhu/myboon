/**
 * React-free projection of Story memories onto a Phoenix candle series.
 *
 * Phoenix responses have used both Unix seconds and Unix milliseconds for
 * candle epochs over time.  Markers use milliseconds internally so a series
 * and an ISO story event can always be compared in the same domain.
 */

export interface PhoenixChartCandle {
  time: number;
  close: number;
}

/** The part of a StoryEvent needed by chart annotations. */
export interface PhoenixChartEvent {
  text: string;
  eventAt: string;
  imageUrl: string | null;
}

/** Runtime-facing input type; unknown values are rejected by the mapper. */
export interface PhoenixChartEventInput {
  text: unknown;
  eventAt: unknown;
  imageUrl?: unknown;
  /** Optional demo-only placement from 0 (left) to 1 (right). */
  chartPosition?: unknown;
}

export interface PhoenixChartEventMarker {
  /** Stable for the same candle series, even when candle epochs are seconds. */
  id: string;
  /** Index into the candle list supplied to the mapper. */
  candleIndex: number;
  /** Candle epoch in Unix milliseconds. */
  time: number;
  /** Close price of the candle to which the memories were attached. */
  price: number;
  /** Exact horizontal placement for demo memories; null uses candle time. */
  chartPosition: number | null;
  /** Memories attached to this candle, newest first. */
  events: PhoenixChartEvent[];
}

interface ValidCandle extends PhoenixChartCandle {
  index: number;
  timeMs: number;
}

interface TimedEvent {
  event: PhoenixChartEvent;
  timeMs: number;
  inputIndex: number;
}

interface MarkerBucket {
  candle: ValidCandle;
  chartPosition: number | null;
  events: TimedEvent[];
}

/**
 * Map Story memories to nearest visible Phoenix candles.
 *
 * Invalid candles/events and memories outside the candle time range are
 * ignored. Multiple time-based memories nearest the same candle are represented
 * by one marker and sorted newest-first. Demo-positioned memories stay distinct
 * even when a partial candle response would map them to the same candle. The
 * function does not mutate either input.
 */
export function mapPhoenixChartEvents(
  candles: readonly PhoenixChartCandle[],
  events: readonly PhoenixChartEventInput[],
): PhoenixChartEventMarker[] {
  const validCandles: ValidCandle[] = [];
  candles.forEach((candle, index) => {
    if (!candle || !Number.isFinite(candle.time) || !Number.isFinite(candle.close)) return;
    const timeMs = normalizeEpoch(candle.time);
    if (!Number.isFinite(timeMs)) return;
    validCandles.push({ ...candle, index, timeMs });
  });

  if (validCandles.length === 0 || events.length === 0) return [];

  const minTime = Math.min(...validCandles.map((candle) => candle.timeMs));
  const maxTime = Math.max(...validCandles.map((candle) => candle.timeMs));
  const grouped = new Map<string, MarkerBucket>();

  events.forEach((event, inputIndex) => {
    if (!event || typeof event.text !== 'string') return;
    const text = event.text.trim();
    if (!text) return;
    const timeMs = parseEventTime(event.eventAt);
    const chartPosition = normalizedChartPosition(event.chartPosition);
    if (timeMs === null || (chartPosition === null && (timeMs < minTime || timeMs > maxTime))) return;

    const timedEvent: TimedEvent = {
      event: {
        text,
        eventAt: typeof event.eventAt === 'string' ? event.eventAt.trim() : String(event.eventAt),
        imageUrl: normalizedImageUrl(event.imageUrl),
      },
      timeMs,
      inputIndex,
    };

    const nearest = chartPosition === null
      ? nearestCandle(validCandles, timeMs)
      : validCandles[Math.round(chartPosition * (validCandles.length - 1))];
    const key = chartPosition === null ? `candle:${nearest.index}` : `position:${inputIndex}`;
    const bucket = grouped.get(key);
    if (bucket) bucket.events.push(timedEvent);
    else grouped.set(key, { candle: nearest, chartPosition, events: [timedEvent] });
  });

  return Array.from(grouped.entries())
    .sort(([, a], [, b]) => markerPosition(a, validCandles) - markerPosition(b, validCandles))
    .map(([key, bucket]) => {
      bucket.events.sort(compareTimedEvents);
      return {
        id: bucket.chartPosition === null
          ? `phoenix-chart-event-${bucket.candle.timeMs}-${bucket.candle.index}`
          : `phoenix-chart-event-${key}`,
        candleIndex: bucket.candle.index,
        time: bucket.candle.timeMs,
        price: bucket.candle.close,
        chartPosition: bucket.chartPosition,
        events: bucket.events.map(({ event }) => event),
      };
    });
}

/** Alias that reads naturally at call sites which refer to memories as events. */
export const mapPhoenixEventsToChartMarkers = mapPhoenixChartEvents;

/** Alias for consumers that use the Story terminology explicitly. */
export const mapStoryEventsToPhoenixChartMarkers = mapPhoenixChartEvents;

function normalizedChartPosition(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : null;
}

function normalizedImageUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function markerPosition(bucket: MarkerBucket, candles: readonly ValidCandle[]): number {
  if (bucket.chartPosition !== null) return bucket.chartPosition;
  if (candles.length <= 1) return 0;
  const candleOrdinal = candles.findIndex((candle) => candle.index === bucket.candle.index);
  return candleOrdinal / (candles.length - 1);
}

function nearestCandle(candles: readonly ValidCandle[], eventTimeMs: number): ValidCandle {
  let nearest = candles[0];
  let nearestDistance = Math.abs(nearest.timeMs - eventTimeMs);

  for (let index = 1; index < candles.length; index += 1) {
    const candidate = candles[index];
    const distance = Math.abs(candidate.timeMs - eventTimeMs);
    // Keeping the first candle on a tie is deterministic and prefers the
    // earlier candle when the input series is chronological.
    if (distance < nearestDistance) {
      nearest = candidate;
      nearestDistance = distance;
    }
  }

  return nearest;
}

function compareTimedEvents(a: TimedEvent, b: TimedEvent): number {
  if (a.timeMs !== b.timeMs) return b.timeMs - a.timeMs;
  const textOrder = compareStrings(a.event.text, b.event.text);
  if (textOrder !== 0) return textOrder;
  const eventAtOrder = compareStrings(a.event.eventAt, b.event.eventAt);
  return eventAtOrder !== 0 ? eventAtOrder : a.inputIndex - b.inputIndex;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function parseEventTime(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? normalizeEpoch(value) : null;
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  // Numeric event timestamps occur in a few older Story payloads.
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(trimmed)) {
    const numeric = Number(trimmed);
    return Number.isFinite(numeric) ? normalizeEpoch(numeric) : null;
  }
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeEpoch(value: number): number {
  // Current Unix milliseconds are ~1e12; Unix seconds are ~1e9.  A generous
  // threshold also keeps dates well into the future unambiguous.
  return Math.abs(value) < 100_000_000_000 ? value * 1000 : value;
}
