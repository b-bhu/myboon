import {
  movePriceByBins,
  validateRange,
  type MeteoraPositionDraft,
} from './meteora.form';

/** Shift the selected window without changing either entered token amount. */
export function rangeShiftPatch(
  draft: MeteoraPositionDraft,
  binStep: number,
  deltaBins: number,
): Partial<MeteoraPositionDraft> {
  if (!Number.isSafeInteger(binStep) || binStep < 1
    || !Number.isSafeInteger(deltaBins) || deltaBins === 0
    || validateRange(draft.requestedMinPrice, draft.requestedMaxPrice, true)) return {};
  const min = movePriceByBins(draft.requestedMinPrice, binStep, deltaBins);
  const max = movePriceByBins(draft.requestedMaxPrice, binStep, deltaBins);
  if (validateRange(min, max, true)) return {};
  return { preset: 'manual', requestedMinPrice: min, requestedMaxPrice: max };
}

/** Use the gesture's starting scale and only count steps actually accepted. */
export function rangeDragDelta(
  horizontalPixels: number,
  trackWidth: number,
  binSpan: number,
  appliedBins: number,
): number {
  if (![horizontalPixels, trackWidth, binSpan, appliedBins].every(Number.isFinite)
    || trackWidth <= 0 || binSpan <= 0) return 0;
  return Math.round(horizontalPixels / (trackWidth * 0.94) * binSpan) - appliedBins;
}
