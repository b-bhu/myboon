import type { MeteoraStrategy } from '@myboon/shared/meteora';
import type { MeteoraPoolBinLiquidity } from '@myboon/shared/meteora';
import {
  METEORA_RANGE_VISUAL_MAX_PERCENT,
  METEORA_RANGE_VISUAL_MIN_PERCENT,
  validateAmount,
} from './meteora.form';
import type { MeteoraPositionTokenMode } from './meteora.position-range';

export interface MeteoraLiquidityDistributionInput {
  strategy: MeteoraStrategy;
  mode: MeteoraPositionTokenMode;
  amountX: string;
  amountY: string;
  tokenXDecimals: number;
  tokenYDecimals: number;
  currentPrice: string;
  minPrice: string;
  maxPrice: string;
  binStep: number;
  inverted?: boolean;
  barCount?: number;
  /** Canonical bin offsets for a retained chart viewport. */
  domainMinBin?: number;
  domainMaxBin?: number;
}

export interface MeteoraLiquidityDistributionBar {
  /** Token amounts represented by this display column. */
  xValue: number;
  yValue: number;
  /** Shared quote-value height in the range [0, 1]. */
  height: number;
  /** Token fractions of this column's quote value. */
  xFraction: number;
  yFraction: number;
}

export interface MeteoraLiquidityDistribution {
  bars: readonly MeteoraLiquidityDistributionBar[];
  allocatedX: number;
  allocatedY: number;
}

export interface MeteoraPoolLiquidityDistributionInput {
  bins: readonly MeteoraPoolBinLiquidity[];
  minBinId: number;
  maxBinId: number;
  currentPrice: string;
  tokenXDecimals: number;
  tokenYDecimals: number;
  inverted?: boolean;
  barCount?: number;
}

/**
 * Convert SDK bin balances into the lower chart's shared columns. It has no
 * dependency on a user's draft, so changing entered amounts cannot alter the
 * existing-pool series.
 */
export function getMeteoraPoolLiquidityDistribution({
  bins,
  minBinId,
  maxBinId,
  currentPrice,
  tokenXDecimals,
  tokenYDecimals,
  inverted = false,
  barCount = DEFAULT_BAR_COUNT,
}: MeteoraPoolLiquidityDistributionInput): readonly number[] {
  const count = Number.isInteger(barCount) && barCount > 0 && barCount <= 512 ? barCount : DEFAULT_BAR_COUNT;
  const empty = Array.from({ length: count }, () => 0);
  if (!Number.isInteger(minBinId) || !Number.isInteger(maxBinId) || minBinId > maxBinId
    || !Number.isInteger(tokenXDecimals) || !Number.isInteger(tokenYDecimals)
    || tokenXDecimals < 0 || tokenYDecimals < 0 || !parsePositivePrice(currentPrice)) return empty;
  const width = maxBinId - minBinId + 1;
  const values = empty.slice();
  for (const bin of bins) {
    if (!Number.isInteger(bin.binId) || bin.binId < minBinId || bin.binId > maxBinId) continue;
    const x = Number(bin.xAtomic) / (10 ** tokenXDecimals);
    const y = Number(bin.yAtomic) / (10 ** tokenYDecimals);
    const price = parsePositivePrice(bin.price);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || !price) continue;
    const index = count === width
      ? bin.binId - minBinId
      : Math.min(count - 1, Math.max(0, Math.floor((bin.binId - minBinId) / width * count)));
    values[index] += x * price + y;
  }
  const maximum = Math.max(0, ...values);
  const normalized = maximum > 0 && Number.isFinite(maximum)
    ? values.map((value) => Math.max(0, Math.min(1, value / maximum)))
    : empty;
  return inverted ? normalized.reverse() : normalized;
}

const DEFAULT_BAR_COUNT = 56;
const MAX_BIN_COUNT = 4_096;
const DECIMAL_PATTERN = /^(0|[1-9]\d*)(?:\.\d+)?$/;

function emptyDistribution(barCount: number): MeteoraLiquidityDistribution {
  const bars = Array.from({ length: barCount }, () => ({
    xValue: 0,
    yValue: 0,
    height: 0,
    xFraction: 0,
    yFraction: 0,
  }));
  return { bars, allocatedX: 0, allocatedY: 0 };
}

function parseTokenAmount(value: string, decimals: number): number | null {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) return null;
  if (!value) return 0;
  const validationError = validateAmount(value, decimals, true);
  if (validationError && !(validationError === 'Amount must be greater than zero'
    && /^0(?:\.0+)?$/.test(value))) return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

function parsePositivePrice(value: string): number | null {
  if (value.length > 128 || !DECIMAL_PATTERN.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function strategyWeight(strategy: MeteoraStrategy, distance: number, count: number): number {
  if (strategy === 'spot') return 1;
  if (strategy === 'curve') return count - distance;
  return distance + 1;
}

function overlap(left: number, right: number, otherLeft: number, otherRight: number): number {
  return Math.max(0, Math.min(right, otherRight) - Math.max(left, otherLeft));
}

/** Offline display estimate; SDK quotes still determine executable amounts. */
export function getMeteoraLiquidityDistribution({
  strategy,
  mode,
  amountX,
  amountY,
  tokenXDecimals,
  tokenYDecimals,
  currentPrice,
  minPrice,
  maxPrice,
  binStep,
  inverted = false,
  barCount = DEFAULT_BAR_COUNT,
  domainMinBin,
  domainMaxBin,
}: MeteoraLiquidityDistributionInput): MeteoraLiquidityDistribution {
  const safeBarCount = Number.isInteger(barCount) && barCount > 0 && barCount <= 512
    ? barCount
    : DEFAULT_BAR_COUNT;
  const empty = () => emptyDistribution(safeBarCount);
  if (mode === 'none') return empty();

  const parsedX = parseTokenAmount(amountX, tokenXDecimals);
  const parsedY = parseTokenAmount(amountY, tokenYDecimals);
  const price = parsePositivePrice(currentPrice);
  const minimum = parsePositivePrice(minPrice);
  const maximum = parsePositivePrice(maxPrice);
  if (parsedX === null || parsedY === null || price === null || minimum === null || maximum === null
    || minimum >= maximum || !Number.isSafeInteger(binStep) || binStep < 1) return empty();

  const factor = 1 + (binStep / 10_000);
  const logFactor = Math.log(factor);
  const minOffset = Math.log(minimum / price) / logFactor;
  const maxOffset = Math.log(maximum / price) / logFactor;
  if (!Number.isFinite(minOffset) || !Number.isFinite(maxOffset) || minOffset >= maxOffset) return empty();

  // Keep the allocation bars in the same fitted bin domain as the range
  // control. The old fixed ±34 domain made a 70-bin one-sided range occupy
  // only half the graph.
  const domainMin = domainMinBin ?? Math.floor(minOffset) - 1;
  const domainMax = domainMaxBin ?? Math.ceil(maxOffset) + 1;
  const binCount = domainMax - domainMin + 1;
  if (!Number.isSafeInteger(domainMin) || !Number.isSafeInteger(domainMax)
    || !Number.isInteger(binCount) || binCount < 1 || binCount > MAX_BIN_COUNT) return empty();

  const selectedMinOffset = Math.floor(minOffset + 1e-9);
  const selectedMaxOffset = Math.ceil(maxOffset - 1e-9);
  const bins = Array.from({ length: binCount }, (_, index) => {
    const offset = domainMin + index;
    const binPrice = price * (factor ** offset);
    const inRange = Number.isFinite(binPrice) && binPrice > 0
      && offset >= selectedMinOffset
      && offset <= selectedMaxOffset;
    return { offset, binPrice, inRange, x: 0, y: 0, xQuote: 0 };
  });

  const yEligible = mode === 'y_only' || mode === 'both';
  const xEligible = mode === 'x_only' || mode === 'both';
  const yBins = yEligible
    ? bins.filter((bin) => bin.inRange && bin.offset <= 0).sort((left, right) => right.offset - left.offset)
    : [];
  const xBins = xEligible
    ? bins.filter((bin) => bin.inRange
      && bin.offset >= (mode === 'both' ? 1 : 0))
    : [];

  if (parsedY > 0 && yBins.length > 0) {
    const weights = yBins.map((_, index) => strategyWeight(strategy, index, yBins.length));
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
    if (totalWeight > 0 && Number.isFinite(totalWeight)) {
      yBins.forEach((bin, index) => {
        bin.y = parsedY * (weights[index] / totalWeight);
      });
    }
  }
  if (parsedX > 0 && xBins.length > 0) {
    const weights = xBins.map((_, index) => strategyWeight(strategy, index, xBins.length));
    const factors = xBins.map((bin, index) => weights[index] / bin.binPrice);
    const totalFactor = factors.reduce((sum, value) => sum + value, 0);
    if (totalFactor > 0 && Number.isFinite(totalFactor)) {
      xBins.forEach((bin, index) => {
        bin.x = parsedX * (factors[index] / totalFactor);
      });
    }
  }

  const width = domainMax - domainMin;
  const displayPercentMin = METEORA_RANGE_VISUAL_MIN_PERCENT;
  const displayPercentMax = METEORA_RANGE_VISUAL_MAX_PERCENT;
  const columnBounds = (index: number): [number, number] => {
    const leftPercent = (index * 100) / safeBarCount;
    const rightPercent = ((index + 1) * 100) / safeBarCount;
    return [
      domainMin + (((leftPercent - displayPercentMin) / (displayPercentMax - displayPercentMin)) * width),
      domainMin + (((rightPercent - displayPercentMin) / (displayPercentMax - displayPercentMin)) * width),
    ];
  };
  const columns = Array.from({ length: safeBarCount }, () => ({ x: 0, y: 0, xQuote: 0 }));
  if (safeBarCount === binCount) {
    // The bounded mobile viewport can afford a literal bin-per-column plot.
    // Avoid the 3% visual rail margins here: overlap rasterization aliases
    // equal Spot bins into alternating half/double-height bars.
    bins.forEach((bin, index) => {
      columns[index].x += bin.x;
      columns[index].y += bin.y;
      columns[index].xQuote += bin.x * bin.binPrice;
    });
  } else {
    bins.forEach((bin) => {
      if (bin.x === 0 && bin.y === 0) return;
      const binLeft = bin.offset - 0.5;
      const binRight = bin.offset + 0.5;
      const firstColumn = Math.max(0, Math.floor((((binLeft - domainMin) / width) * (displayPercentMax - displayPercentMin) + displayPercentMin) * safeBarCount / 100));
      const lastColumn = Math.min(safeBarCount - 1, Math.ceil((((binRight - domainMin) / width) * (displayPercentMax - displayPercentMin) + displayPercentMin) * safeBarCount / 100) - 1);
      for (let index = firstColumn; index <= lastColumn; index += 1) {
        const [columnLeft, columnRight] = columnBounds(index);
        const value = overlap(binLeft, binRight, columnLeft, columnRight);
        if (value <= 0) continue;
        columns[index].x += bin.x * value;
        columns[index].y += bin.y * value;
        columns[index].xQuote += bin.x * bin.binPrice * value;
      }
    });
  }

  const rawBars = columns.map(({ x, y, xQuote }) => {
    const quoteValue = y + xQuote;
    return {
      xValue: x,
      yValue: y,
      quoteValue,
      xFraction: quoteValue > 0 ? xQuote / quoteValue : 0,
      yFraction: quoteValue > 0 ? y / quoteValue : 0,
    };
  });
  const peak = rawBars.reduce((maximumValue, bar) => Math.max(maximumValue, bar.quoteValue), 0);
  if (!Number.isFinite(peak)) return empty();
  const bars = rawBars.map((bar) => ({
    xValue: bar.xValue,
    yValue: bar.yValue,
    height: peak > 0 ? Math.max(0, Math.min(1, bar.quoteValue / peak)) : 0,
    xFraction: bar.xFraction,
    yFraction: bar.yFraction,
  }));
  if (inverted) bars.reverse();

  const allocatedX = columns.reduce((sum, column) => sum + column.x, 0);
  const allocatedY = columns.reduce((sum, column) => sum + column.y, 0);
  return { bars, allocatedX, allocatedY };
}

/** Maps the official SDK allocator's per-bin atomic amounts into chart columns. */
export function getMeteoraSdkLiquidityDistribution({
  allocations,
  minBinId,
  maxBinId,
  activeBinId,
  activePrice,
  binStep,
  tokenXDecimals,
  tokenYDecimals,
  inverted = false,
  barCount = DEFAULT_BAR_COUNT,
}: {
  allocations: readonly { binId: number; xAtomic: string; yAtomic: string }[];
  minBinId: number;
  maxBinId: number;
  activeBinId: number;
  activePrice: string;
  binStep: number;
  tokenXDecimals: number;
  tokenYDecimals: number;
  inverted?: boolean;
  barCount?: number;
}): MeteoraLiquidityDistribution {
  const count = Number.isInteger(barCount) && barCount > 0 && barCount <= 512 ? barCount : DEFAULT_BAR_COUNT;
  const empty = () => emptyDistribution(count);
  if (![minBinId, maxBinId, activeBinId, binStep, tokenXDecimals, tokenYDecimals].every(Number.isInteger)
    || minBinId > maxBinId || binStep < 1 || tokenXDecimals < 0 || tokenYDecimals < 0) return empty();
  const active = parsePositivePrice(activePrice);
  if (!active) return empty();
  const width = maxBinId - minBinId + 1;
  const step = 1 + binStep / 10_000;
  if (!Number.isFinite(step) || step <= 1) return empty();
  const columns = Array.from({ length: count }, () => ({ x: 0, y: 0, xQuote: 0 }));
  let allocatedX = 0;
  let allocatedY = 0;
  for (const allocation of allocations) {
    if (!Number.isInteger(allocation.binId) || allocation.binId < minBinId || allocation.binId > maxBinId
      || !/^\d+$/.test(allocation.xAtomic) || !/^\d+$/.test(allocation.yAtomic)) continue;
    const x = Number(allocation.xAtomic) / (10 ** tokenXDecimals);
    const y = Number(allocation.yAtomic) / (10 ** tokenYDecimals);
    const price = active * (step ** (allocation.binId - activeBinId));
    if (![x, y, price].every(Number.isFinite) || x < 0 || y < 0 || price <= 0) continue;
    const index = count === width
      ? allocation.binId - minBinId
      : Math.min(count - 1, Math.max(0, Math.floor((allocation.binId - minBinId) / width * count)));
    columns[index].x += x;
    columns[index].y += y;
    columns[index].xQuote += x * price;
    allocatedX += x;
    allocatedY += y;
  }
  const rawBars = columns.map(({ x, y, xQuote }) => {
    const quoteValue = xQuote + y;
    return {
      xValue: x,
      yValue: y,
      quoteValue,
      xFraction: quoteValue > 0 ? xQuote / quoteValue : 0,
      yFraction: quoteValue > 0 ? y / quoteValue : 0,
    };
  });
  const peak = Math.max(0, ...rawBars.map((bar) => bar.quoteValue));
  const bars = rawBars.map((bar) => ({
    xValue: bar.xValue,
    yValue: bar.yValue,
    height: peak > 0 ? Math.max(0, Math.min(1, bar.quoteValue / peak)) : 0,
    xFraction: bar.xFraction,
    yFraction: bar.yFraction,
  }));
  return { bars: inverted ? bars.reverse() : bars, allocatedX, allocatedY };
}
