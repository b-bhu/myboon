import type { MeteoraPositionDraft } from './meteora.form';
import {
  compareDecimalStrings,
  isPositiveDecimal,
  liquidityDistributionWeight,
  validateAmount,
  validateRange,
} from './meteora.form';

export type MeteoraPositionTokenMode = 'x_only' | 'y_only' | 'both' | 'none';

function isCanonicalZero(value: string): boolean {
  return /^0(?:\.0+)?$/.test(value);
}

function isValidPrice(value: string): boolean {
  return /^(0|[1-9]\d*)(?:\.\d+)?$/.test(value) && isPositiveDecimal(value);
}

function classifyAmount(value: string, decimals: number): 'empty' | 'positive' | 'invalid' {
  if (!value) return 'empty';
  const error = validateAmount(value, decimals, true);
  if (error === 'Amount must be greater than zero' && isCanonicalZero(value)) return 'empty';
  if (error || !isPositiveDecimal(value)) return 'invalid';
  return 'positive';
}

export function getPositionTokenMode(
  draft: MeteoraPositionDraft,
  tokenXDecimals = 9,
  tokenYDecimals = 6,
  addMode = false,
): MeteoraPositionTokenMode {
  const x = classifyAmount(draft.amountX, tokenXDecimals);
  const y = classifyAmount(draft.amountY, tokenYDecimals);
  if (x === 'invalid' || y === 'invalid') return 'none';

  // Existing-position adds use the entered manual amounts, even if the
  // create-position switches happen to remain enabled in the draft.
  if (!addMode && draft.fundingMode === 'single') {
    return draft.singleTokenSide === 'x' && x === 'positive'
      ? 'both'
      : draft.singleTokenSide === 'y' && y === 'positive'
        ? 'both'
        : 'none';
  }

  if (!addMode && draft.autoFill) {
    return x === 'positive' || y === 'positive' ? 'both' : 'none';
  }

  if (x === 'positive' && y === 'positive') return 'both';
  if (x === 'positive') return 'x_only';
  if (y === 'positive') return 'y_only';
  return 'none';
}

export interface DefaultTokenRangeBounds {
  minPrice: string;
  maxPrice: string;
  /** Exact active-to-far-edge SDK prices for 70-bin one-sided defaults. */
  xOnlyMaxPrice?: string;
  yOnlyMinPrice?: string;
}

export interface ApplyDefaultTokenRangeInput {
  draft: MeteoraPositionDraft;
  currentPrice: string | null | undefined;
  bounds: DefaultTokenRangeBounds | null | undefined;
  rangeEdited: boolean;
  fixedRange: boolean;
  tokenXDecimals: number;
  tokenYDecimals: number;
}

export function applyDefaultTokenRange({
  draft,
  currentPrice,
  bounds,
  rangeEdited,
  fixedRange,
  tokenXDecimals,
  tokenYDecimals,
}: ApplyDefaultTokenRangeInput): MeteoraPositionDraft {
  if (rangeEdited || fixedRange || !currentPrice || !bounds) return draft;
  if (!isValidPrice(currentPrice)
    || !isValidPrice(bounds.minPrice)
    || !isValidPrice(bounds.maxPrice)
    || validateRange(bounds.minPrice, bounds.maxPrice, true)
    || compareDecimalStrings(currentPrice, bounds.minPrice) < 0
    || compareDecimalStrings(currentPrice, bounds.maxPrice) > 0) {
    return draft;
  }

  const mode = getPositionTokenMode(draft, tokenXDecimals, tokenYDecimals);
  const minPrice = mode === 'x_only' ? currentPrice
    : mode === 'y_only' && bounds.yOnlyMinPrice ? bounds.yOnlyMinPrice
      : bounds.minPrice;
  const maxPrice = mode === 'y_only' ? currentPrice
    : mode === 'x_only' && bounds.xOnlyMaxPrice ? bounds.xOnlyMaxPrice
      : bounds.maxPrice;
  if (!isValidPrice(minPrice)
    || !isValidPrice(maxPrice)
    || validateRange(minPrice, maxPrice, true)) {
    return draft;
  }

  return {
    ...draft,
    preset: 'manual',
    requestedMinPrice: minPrice,
    requestedMaxPrice: maxPrice,
  };
}

export interface RangeBarAllocationInput {
  mode: MeteoraPositionTokenMode;
  inverted: boolean;
  minPercent: number;
  maxPercent: number;
  currentPercent: number;
  barPercent: number;
}

export interface RangeBarAllocation {
  token: 'x' | 'y' | null;
  normalizedPosition: number;
}

/** Shape strategy weights from the active-price edge toward a funded range edge. */
export function getRangeBarWeight(
  strategy: Parameters<typeof liquidityDistributionWeight>[0],
  normalizedPosition: number,
): number {
  const position = Math.max(0, Math.min(1, normalizedPosition));
  return liquidityDistributionWeight(strategy, strategy === 'spot' ? position : 0.5 + (position * 0.5));
}

function normalized(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function getRangeBarAllocation({
  mode,
  inverted,
  minPercent,
  maxPercent,
  currentPercent,
  barPercent,
}: RangeBarAllocationInput): RangeBarAllocation {
  const min = Math.min(minPercent, maxPercent);
  const max = Math.max(minPercent, maxPercent);
  if (mode === 'none' || barPercent < min || barPercent > max) {
    return { token: null, normalizedPosition: 0 };
  }

  const current = currentPercent;
  const currentWithinRange = current >= min && current <= max;
  const leftSpan = currentWithinRange ? current - min : max - min;
  const rightSpan = currentWithinRange ? max - current : max - min;

  if (mode === 'x_only') {
    const onFundedSide = inverted ? barPercent <= current : barPercent >= current;
    if (!onFundedSide) return { token: null, normalizedPosition: 0 };
    const position = inverted
      ? leftSpan === 0 ? 0 : (currentWithinRange ? current - barPercent : max - barPercent) / leftSpan
      : rightSpan === 0 ? 0 : (barPercent - (currentWithinRange ? current : min)) / rightSpan;
    return { token: 'x', normalizedPosition: normalized(position) };
  }

  if (mode === 'y_only') {
    const onFundedSide = inverted ? barPercent >= current : barPercent <= current;
    if (!onFundedSide) return { token: null, normalizedPosition: 0 };
    const position = inverted
      ? rightSpan === 0 ? 0 : (barPercent - (currentWithinRange ? current : min)) / rightSpan
      : leftSpan === 0 ? 0 : ((currentWithinRange ? current : max) - barPercent) / leftSpan;
    return { token: 'y', normalizedPosition: normalized(position) };
  }

  if (barPercent < current && current > min) {
    return {
      token: inverted ? 'x' : 'y',
      normalizedPosition: leftSpan === 0 ? 0 : normalized(
        ((currentWithinRange ? current : max) - barPercent) / leftSpan,
      ),
    };
  }
  return {
    token: inverted ? 'y' : 'x',
    normalizedPosition: rightSpan === 0 ? 0 : normalized((barPercent - (current < min ? min : current)) / rightSpan),
  };
}
