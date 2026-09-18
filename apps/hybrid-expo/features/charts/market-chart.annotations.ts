import {
  xForCandleIndex,
  type MarketChartGeometry,
} from '@/features/charts/market-chart.geometry';
import type {
  MarketCandle,
  MarketChartAnnotation,
} from '@/features/charts/market-chart.types';
import { clamp } from '@/features/charts/market-chart.viewport';

export const MARKET_CHART_ANNOTATION_SIZE = 28;
export const MARKET_CHART_ANNOTATION_DOT_SIZE = 8;
export const MARKET_CHART_ANNOTATION_HIT_SIZE = 44;
const ANNOTATION_CLUSTER_WINDOW = 28;
const ANNOTATION_RAIL_OFFSET = 8;

export interface MarketChartAnnotationLayout {
  readonly id: string;
  readonly annotations: readonly MarketChartAnnotation[];
  readonly candleIndex: number;
  readonly x: number;
  readonly y: number;
  readonly count: number;
}

interface AnnotationPoint {
  readonly annotation: MarketChartAnnotation;
  readonly candleIndex: number;
  readonly x: number;
}

export function createMarketChartAnnotationLayouts(
  annotations: readonly MarketChartAnnotation[],
  candles: readonly MarketCandle[],
  geometry: MarketChartGeometry,
): MarketChartAnnotationLayout[] {
  if (annotations.length === 0 || candles.length === 0) return [];

  const indexByTime = new Map<number, number>();
  for (
    let index = geometry.visibleStartIndex;
    index <= geometry.visibleEndIndex;
    index += 1
  ) {
    const candle = candles[index];
    if (candle) indexByTime.set(candle.timeMs, index);
  }

  const points = annotations.flatMap((annotation): AnnotationPoint[] => {
    const candleIndex = indexByTime.get(annotation.timeMs);
    if (candleIndex === undefined || !validAnnotation(annotation)) return [];
    const candle = candles[candleIndex];
    if (!candle) return [];
    const x = xForCandleIndex(geometry, candleIndex);
    if (x < geometry.plotLeft || x > geometry.plotRight) return [];
    return [{
      annotation,
      candleIndex,
      x,
    }];
  }).sort((left, right) => left.x - right.x || left.annotation.id.localeCompare(right.annotation.id));

  const candleGroups: AnnotationPoint[][] = [];
  points.forEach((point) => {
    const current = candleGroups.at(-1);
    if (!current || current[0].candleIndex !== point.candleIndex) {
      candleGroups.push([point]);
      return;
    }
    current.push(point);
  });

  const clusters: AnnotationPoint[][][] = [];
  candleGroups.forEach((group) => {
    const current = clusters.at(-1);
    if (!current || groupX(group) - groupX(current[0]) > ANNOTATION_CLUSTER_WINDOW) {
      clusters.push([group]);
      return;
    }
    current.push(group);
  });

  const radius = MARKET_CHART_ANNOTATION_SIZE / 2;
  const railY = clamp(
    geometry.volumeTop < geometry.volumeBottom
      ? geometry.volumeTop + ANNOTATION_RAIL_OFFSET
      : geometry.priceBottom - ANNOTATION_RAIL_OFFSET,
    geometry.plotTop + radius,
    geometry.volumeBottom - radius,
  );
  return clusters.map((cluster) => {
    const pointsInCluster = cluster.flat();
    const annotationsInCluster = pointsInCluster.map((point) => point.annotation);
    const x = clamp(
      pointsInCluster.reduce((sum, point) => sum + point.x, 0) / pointsInCluster.length,
      geometry.plotLeft + radius,
      geometry.plotRight - radius,
    );
    return {
      id: annotationsInCluster.map((annotation) => annotation.id).join('|'),
      annotations: annotationsInCluster,
      candleIndex: pointsInCluster[0].candleIndex,
      x,
      y: railY,
      count: annotationsInCluster.reduce(
        (sum, annotation) => sum + Math.max(1, annotation.count ?? 1),
        0,
      ),
    };
  });
}

function groupX(group: readonly AnnotationPoint[]): number {
  return group.reduce((sum, point) => sum + point.x, 0) / group.length;
}

export function findMarketChartAnnotationAtPoint(
  layouts: readonly MarketChartAnnotationLayout[],
  x: number,
  y: number,
): MarketChartAnnotationLayout | null {
  const hitRadius = MARKET_CHART_ANNOTATION_HIT_SIZE / 2;
  let nearest: MarketChartAnnotationLayout | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  layouts.forEach((layout) => {
    const distance = Math.hypot(layout.x - x, layout.y - y);
    if (distance <= hitRadius && distance < nearestDistance) {
      nearest = layout;
      nearestDistance = distance;
    }
  });
  return nearest;
}

export function nextAnnotationInLayout(
  layout: MarketChartAnnotationLayout,
  selectedAnnotationId: string | null | undefined,
): MarketChartAnnotation {
  const currentIndex = layout.annotations.findIndex(
    (annotation) => annotation.id === selectedAnnotationId,
  );
  return layout.annotations[(currentIndex + 1) % layout.annotations.length];
}

function validAnnotation(annotation: MarketChartAnnotation): boolean {
  return Boolean(
    annotation.id.trim()
    && annotation.label.trim()
    && annotation.accessibilityLabel.trim()
    && Number.isFinite(annotation.timeMs),
  );
}
