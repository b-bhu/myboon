import {
  applyRangeEdgeBinDelta,
  METEORA_RANGE_VISUAL_MIN_PERCENT,
  METEORA_RANGE_VISUAL_MAX_PERCENT,
  compareDecimalStrings,
  decimalToAtomic,
  formatPoolPrice,
  isPositiveDecimal,
  movePriceByBins,
  type MeteoraAutoFillAmounts,
  type MeteoraPositionDraft,
} from './meteora.form';
import { priceForPoolBin, resolveManualRangeForDisplay, type MeteoraExecutionPoolState } from '@myboon/shared/meteora';
import { isEmptyTokenAmount } from './meteora.position-validation';

export function mergePositionDraftPatch(
  draft: MeteoraPositionDraft,
  patch: Partial<MeteoraPositionDraft>,
): MeteoraPositionDraft {
  const changed = (Object.keys(patch) as (keyof MeteoraPositionDraft)[])
    .some((key) => patch[key] !== draft[key]);
  return changed ? { ...draft, ...patch } : draft;
}

/** Build each drag step from the latest draft so batched movements accumulate. */
export function rangeBinDeltaPatch(
  draft: MeteoraPositionDraft,
  input: { currentPrice: string | null; binStep: number; edge: 'min' | 'max'; deltaBins: number },
): Partial<MeteoraPositionDraft> {
  const adjusted = applyRangeEdgeBinDelta({
    ...input,
    minPrice: draft.requestedMinPrice,
    maxPrice: draft.requestedMaxPrice,
  });
  return adjusted ? {
    preset: 'manual',
    requestedMinPrice: adjusted.minPrice,
    requestedMaxPrice: adjusted.maxPrice,
  } : {};
}

/**
 * Gesture steps use canonical SDK bin ids once pool state is available. This
 * prevents a rounded display price from snapping outward on the next step.
 */
export function rangePoolBinDeltaPatch(
  draft: MeteoraPositionDraft,
  input: { poolState: MeteoraExecutionPoolState; edge: 'min' | 'max'; deltaBins: number },
): Partial<MeteoraPositionDraft> {
  if (!Number.isSafeInteger(input.deltaBins) || input.deltaBins === 0) return {};
  try {
    const range = resolveManualRangeForDisplay(
      input.poolState, draft.requestedMinPrice, draft.requestedMaxPrice,
    );
    const minBinId = input.edge === 'min' ? range.minBinId + input.deltaBins : range.minBinId;
    const maxBinId = input.edge === 'max' ? range.maxBinId + input.deltaBins : range.maxBinId;
    if (minBinId >= maxBinId) return {};
    return {
      preset: 'manual',
      requestedMinPrice: priceForPoolBin(input.poolState, minBinId),
      requestedMaxPrice: priceForPoolBin(input.poolState, maxBinId),
    };
  } catch {
    return {};
  }
}

/** Translate both canonical edges together, preserving the executable width. */
export function rangePoolBinShiftPatch(
  draft: MeteoraPositionDraft,
  poolState: MeteoraExecutionPoolState,
  deltaBins: number,
): Partial<MeteoraPositionDraft> {
  if (!Number.isSafeInteger(deltaBins) || deltaBins === 0) return {};
  try {
    const range = resolveManualRangeForDisplay(poolState, draft.requestedMinPrice, draft.requestedMaxPrice);
    return {
      preset: 'manual',
      requestedMinPrice: priceForPoolBin(poolState, range.minBinId + deltaBins),
      requestedMaxPrice: priceForPoolBin(poolState, range.maxBinId + deltaBins),
    };
  } catch {
    return {};
  }
}

/** Round down at the token's precision, including for a one-atomic-unit balance. */
export function amountFromBalance(
  balance: string | null | undefined,
  decimals: number,
  divisor: 1 | 2,
  reserve = '0',
): string | null {
  if (!balance || !isPositiveDecimal(balance)) return null;
  try {
    const balanceAtomic = BigInt(decimalToAtomic(balance, decimals));
    const reserveAtomic = reserve && isPositiveDecimal(reserve)
      ? BigInt(decimalToAtomic(reserve, decimals)) : 0n;
    const atomic = (balanceAtomic > reserveAtomic ? balanceAtomic - reserveAtomic : 0n) / BigInt(divisor);
    const padded = atomic.toString().padStart(decimals + 1, '0');
    if (decimals === 0) return padded;
    const whole = padded.slice(0, -decimals);
    const fraction = padded.slice(-decimals).replace(/0+$/, '');
    return fraction ? `${whole}.${fraction}` : whole;
  } catch {
    return null;
  }
}

/** Native SOL shortcuts are unsafe until the exact fee/rent reserve is known. */
export function canUseMeteoraBalanceShortcut(input: {
  isNative: boolean;
  isCreating: boolean;
  nativeReserve: string | null;
  nativeBalance: string | null;
}): boolean {
  return !input.isNative || !input.isCreating
    || (input.nativeReserve !== null && input.nativeBalance !== null);
}

export function exceedsBalance(
  amount: string,
  balance: string | null | undefined,
  estimated = false,
  reserve = '0',
): boolean {
  let required = amount;
  try {
    if (isPositiveDecimal(amount) && isPositiveDecimal(reserve)) {
      const [whole, fraction = ''] = amount.split('.');
      const [reserveWhole, reserveFraction = ''] = reserve.split('.');
      const precision = Math.max(fraction.length, reserveFraction.length);
      const atomic = BigInt(`${whole}${fraction.padEnd(precision, '0')}`)
        + BigInt(`${reserveWhole}${reserveFraction.padEnd(precision, '0')}`);
      required = `${atomic / 10n ** BigInt(precision)}.${(atomic % 10n ** BigInt(precision)).toString().padStart(precision, '0')}`.replace(/\.0+$/, '');
    }
  } catch { return false; }
  return isPositiveDecimal(amount)
    && !!balance
    && /^\d+(?:\.\d+)?$/.test(balance)
    // A pool-price estimate cannot prove a deficit against a nonzero balance:
    // the live strategy/bin quote may require a different token ratio.
    && (!estimated || !/[1-9]/.test(balance))
    && compareDecimalStrings(required, balance) > 0;
}

/** A display inversion never changes the canonical Y-per-X execution draft. */
export function reciprocalPrice(value: string | null): string {
  if (!value || !isPositiveDecimal(value)) return '';
  const [whole, fraction = ''] = value.split('.');
  const precision = Math.max(18, whole.length + 12);
  const denominator = BigInt(`${whole}${fraction}`);
  const quotient = (10n ** BigInt(precision + fraction.length)) / denominator;
  const padded = quotient.toString().padStart(precision + 1, '0');
  const resultWhole = padded.slice(0, -precision);
  const resultFraction = padded.slice(-precision).replace(/0+$/, '');
  return resultFraction ? `${resultWhole}.${resultFraction}` : resultWhole;
}

export function priceDeltaLabel(value: string, currentPrice: string | null): string {
  const price = Number(value);
  const current = Number(currentPrice);
  if (!isPositiveDecimal(value) || !currentPrice || !isPositiveDecimal(currentPrice)
    || !Number.isFinite(price) || !Number.isFinite(current) || current <= 0) return '—';
  const delta = (price / current - 1) * 100;
  return `${delta > 0 ? '+' : ''}${delta.toFixed(2)}%`;
}

/** Keep narrow ranges at their real positions; touch targets do not widen the rail. */
export function rangeHandleGeometry(minPercent: number, maxPercent: number, currentPercent: number) {
  const clamp = (value: number, fallback: number) => Math.max(METEORA_RANGE_VISUAL_MIN_PERCENT,
    Math.min(METEORA_RANGE_VISUAL_MAX_PERCENT, Number.isFinite(value) ? value : fallback));
  const min = clamp(minPercent, METEORA_RANGE_VISUAL_MIN_PERCENT);
  return {
    minPercent: min,
    maxPercent: Math.max(min, clamp(maxPercent, METEORA_RANGE_VISUAL_MAX_PERCENT)),
    currentPercent: clamp(currentPercent, 50),
  };
}

export function rangeChartGeometry(minPrice: string, maxPrice: string, currentPrice: string, binStep: number) {
  const step = Math.log(1 + Math.max(1, binStep) / 10_000);
  const minBin = Math.log(Number(minPrice) / Number(currentPrice)) / step;
  const maxBin = Math.log(Number(maxPrice) / Number(currentPrice)) / step;
  if (!isPositiveDecimal(minPrice) || !isPositiveDecimal(maxPrice)
    || !isPositiveDecimal(currentPrice) || !Number.isFinite(minBin) || !Number.isFinite(maxBin)
    || minBin >= maxBin) return null;
  // Fit the selected executable range. One extra bin on each side keeps an
  // endpoint handle and the active marker visible without reserving an empty
  // centered half for a one-sided position.
  const domainMin = Math.floor(minBin) - 1;
  const domainMax = Math.ceil(maxBin) + 1;
  const binSpan = domainMax - domainMin;
  const percent = (bin: number) => 3 + ((bin - domainMin) / binSpan) * 94;
  return {
    minPercent: percent(minBin),
    maxPercent: percent(maxBin),
    currentPercent: percent(0),
    binSpan,
    domainMinBin: domainMin,
    domainMaxBin: domainMax,
    axisMinPrice: movePriceByBins(currentPrice, binStep, domainMin),
    axisMaxPrice: movePriceByBins(currentPrice, binStep, domainMax),
  };
}

export function tokenQuoteLabel(
  amount: string,
  currentPrice: string | null,
  side: 'x' | 'y',
  otherSymbol: string,
): string | undefined {
  if (!isPositiveDecimal(amount) || !currentPrice || !isPositiveDecimal(currentPrice)) {
    return undefined;
  }
  const equivalent = side === 'x'
    ? Number(amount) * Number(currentPrice)
    : Number(amount) / Number(currentPrice);
  if (!Number.isFinite(equivalent) || equivalent <= 0) return undefined;
  return `≈ ${formatPoolPrice(String(equivalent), 6)} ${otherSymbol}`;
}

/** Typing on either side makes that token the Auto-Fill input. */
export function tokenAmountPatch(
  draft: MeteoraPositionDraft,
  side: 'x' | 'y',
  value: string,
): Partial<MeteoraPositionDraft> {
  const otherAmount = side === 'x' ? draft.amountY : draft.amountX;
  if (draft.autoFill && isEmptyTokenAmount(value) && isPositiveDecimal(otherAmount)) {
    return side === 'x' ? { amountX: '', amountY: otherAmount } : { amountY: '', amountX: otherAmount };
  }
  if (side === 'x') return { amountX: value, ...(draft.autoFill ? { amountY: '' } : {}) };
  return { amountY: value, ...(draft.autoFill ? { amountX: '' } : {}) };
}

/**
 * Toggling Auto-Fill does not discard entered amounts. Disabling may materialize
 * a live quote only into a side that was still empty while Auto-Fill was on.
 */
export function autoFillPatch(
  draft: MeteoraPositionDraft,
  enabled: boolean,
  quote: Partial<MeteoraAutoFillAmounts> = {},
): Partial<MeteoraPositionDraft> {
  if (enabled) {
    return {
      autoFill: true,
      amountX: draft.amountX,
      amountY: draft.amountY,
    };
  }
  return {
    autoFill: false,
    amountX: isEmptyTokenAmount(draft.amountX) ? quote.amountX ?? draft.amountX : draft.amountX,
    amountY: isEmptyTokenAmount(draft.amountY) ? quote.amountY ?? draft.amountY : draft.amountY,
  };
}

export interface MeteoraChartBinViewport {
  minBinId: number;
  maxBinId: number;
}

/** The SDK deliberately bounds read-only bin windows to avoid RPC storms. */
export const METEORA_POOL_LIQUIDITY_MAX_BINS = 128;

/**
 * Read the full retained viewport, not only the selected range. Otherwise
 * margin bins displayed by the lower histogram would be invented as zero.
 */
export function getMeteoraPoolLiquidityViewport(
  selected: MeteoraChartBinViewport | null,
  retainedViewport: MeteoraChartBinViewport | null,
): MeteoraChartBinViewport | null {
  if (!selected) return null;
  const viewport = retainedViewport ?? nextMeteoraChartBinViewport(selected);
  if (!viewport || !Number.isInteger(viewport.minBinId) || !Number.isInteger(viewport.maxBinId)
    || viewport.minBinId > viewport.maxBinId
    || viewport.maxBinId - viewport.minBinId + 1 > METEORA_POOL_LIQUIDITY_MAX_BINS) return null;
  return viewport;
}

/** A preview is executable only against the exact active SDK state it quoted. */
export function getMeteoraPoolStateSnapshotKey(
  state: Pick<MeteoraExecutionPoolState, 'poolAddress' | 'activeBinId' | 'activePrice'> | null | undefined,
): string | null {
  if (!state || !state.poolAddress || !Number.isInteger(state.activeBinId) || !isPositiveDecimal(state.activePrice)) return null;
  return `${state.poolAddress}:${state.activeBinId}:${state.activePrice}`;
}

/**
 * Retain a small visual margin while a gesture moves a selected bin window.
 * The viewport moves only once an edge leaves it, so the white range grip
 * visibly translates instead of being recentered after every bin step.
 */
export function nextMeteoraChartBinViewport(
  selected: MeteoraChartBinViewport,
  previous: MeteoraChartBinViewport | null = null,
  marginBins = 3,
): MeteoraChartBinViewport | null {
  if (!Number.isInteger(selected.minBinId) || !Number.isInteger(selected.maxBinId)
    || selected.minBinId > selected.maxBinId || !Number.isInteger(marginBins) || marginBins < 0) return null;
  // Editing one price edge can temporarily create an oversized window. Once
  // the range is compact again, discard that unreadable viewport rather than
  // retaining it and permanently exceeding the SDK's liquidity-read cap.
  if (previous && previous.maxBinId - previous.minBinId + 1 > METEORA_POOL_LIQUIDITY_MAX_BINS) previous = null;
  if (previous && Number.isInteger(previous.minBinId) && Number.isInteger(previous.maxBinId)
    && previous.minBinId <= selected.minBinId && previous.maxBinId >= selected.maxBinId) {
    return previous;
  }
  const selectedWidth = selected.maxBinId - selected.minBinId + 1;
  const previousWidth = previous && Number.isInteger(previous.minBinId) && Number.isInteger(previous.maxBinId)
    ? previous.maxBinId - previous.minBinId + 1 : 0;
  const width = Math.max(selectedWidth + marginBins * 2, previousWidth);
  if (!previous || previous.minBinId > selected.minBinId) {
    return { minBinId: selected.minBinId - marginBins, maxBinId: selected.minBinId - marginBins + width - 1 };
  }
  return { maxBinId: selected.maxBinId + marginBins, minBinId: selected.maxBinId + marginBins - width + 1 };
}

/** Maps canonical bin ids to the displayed price orientation without rounding prices. */
export function rangeChartBinGeometry({
  activeBinId,
  minBinId,
  maxBinId,
  viewport,
  inverted = false,
}: {
  activeBinId: number;
  minBinId: number;
  maxBinId: number;
  viewport: MeteoraChartBinViewport;
  inverted?: boolean;
}) {
  if (![activeBinId, minBinId, maxBinId, viewport.minBinId, viewport.maxBinId].every(Number.isInteger)
    || minBinId > maxBinId || viewport.minBinId >= viewport.maxBinId) return null;
  const span = viewport.maxBinId - viewport.minBinId;
  const percent = (binId: number) => 3 + (((inverted ? viewport.maxBinId - binId : binId - viewport.minBinId) / span) * 94);
  return {
    minPercent: percent(inverted ? maxBinId : minBinId),
    maxPercent: percent(inverted ? minBinId : maxBinId),
    currentPercent: percent(activeBinId),
    binSpan: span,
    domainMinBin: viewport.minBinId,
    domainMaxBin: viewport.maxBinId,
  };
}
