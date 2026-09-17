import {
  xForCandleIndex,
  yForPrice,
  type MarketChartGeometry,
} from '@/features/charts/market-chart.geometry';
import type {
  MarketCandle,
  MarketChartAnnotation,
} from '@/features/charts/market-chart.types';
import { clamp } from '@/features/charts/market-chart.viewport';

export const MARKET_CHART_ANNOTATION_SIZE = 30;
export const MARKET_CHART_ANNOTATION_HIT_SIZE = 44;
const ANNOTATION_STEM_OFFSET = 34;
const ANNOTATION_CLUSTER_DISTANCE = MARKET_CHART_ANNOTATION_SIZE + 8;

export interface MarketChartAnnotationLayout {
  readonly id: string;
  readonly annotations: readonly MarketChartAnnotation[];
  readonly candleIndex: number;
  readonly x: number;
  readonly y: number;
  readonly anchorY: number;
  readonly count: number;
}

interface AnnotationPoint {
  readonly annotation: MarketChartAnnotation;
  readonly candleIndex: number;
  readonly x: number;
  readonly anchorY: number;
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
      anchorY: yForPrice(geometry, candle.close),
    }];
  }).sort((left, right) => left.x - right.x || left.annotation.id.localeCompare(right.annotation.id));

  const clusters: AnnotationPoint[][] = [];
  points.forEach((point) => {
    const current = clusters.at(-1);
    if (!current) {
      clusters.push([point]);
      return;
    }
    const currentCenter = current.reduce((sum, item) => sum + item.x, 0) / current.length;
    if (point.x - currentCenter <= ANNOTATION_CLUSTER_DISTANCE) {
      current.push(point);
    } else {
      clusters.push([point]);
    }
  });

  const radius = MARKET_CHART_ANNOTATION_SIZE / 2;
  return clusters.map((cluster) => {
    const annotationsInCluster = cluster.map((point) => point.annotation);
    const x = clamp(
      cluster.reduce((sum, point) => sum + point.x, 0) / cluster.length,
      geometry.plotLeft + radius,
      geometry.plotRight - radius,
    );
    const anchorY = Math.min(...cluster.map((point) => point.anchorY));
    const y = clamp(
      anchorY - ANNOTATION_STEM_OFFSET,
      geometry.plotTop + radius,
      geometry.priceBottom - radius,
    );
    return {
      id: annotationsInCluster.map((annotation) => annotation.id).join('|'),
      annotations: annotationsInCluster,
      candleIndex: cluster[0].candleIndex,
      x,
      y,
      anchorY,
      count: annotationsInCluster.reduce(
        (sum, annotation) => sum + Math.max(1, annotation.count ?? 1),
        0,
      ),
    };
  });
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
