import type {
  MeteoraCreatePositionRequest,
  MeteoraExecutionPoolState,
  MeteoraRangeRequest,
} from '@myboon/shared/meteora';
import { snapRangeToPoolState } from '@myboon/shared/meteora';
import {
  isPositiveDecimal,
  validateAmount,
  validateRange,
  type MeteoraPositionDraft,
} from './meteora.form';
import { getPositionTokenMode, type MeteoraPositionTokenMode } from './meteora.position-range';

export interface MeteoraValidationToken {
  symbol: string;
  decimals: number;
}

export interface MeteoraPositionDraftValidationInput {
  draft: MeteoraPositionDraft;
  tokenX: MeteoraValidationToken;
  tokenY: MeteoraValidationToken;
  addMode?: boolean;
  /** Fresh SDK state enables local, executable bin validation before preview. */
  poolState?: MeteoraExecutionPoolState | null;
}

export interface MeteoraPositionDraftValidation {
  valid: boolean;
  amountXError: string | null;
  amountYError: string | null;
  rangeError: string | null;
  blockerLabel: string | null;
}

function isZeroDecimal(value: string): boolean {
  return /^0(?:\.0+)?$/.test(value);
}

/** Empty input and a correctly formatted zero are equivalent on an unused side. */
export function isEmptyTokenAmount(value: string): boolean {
  return !value || isZeroDecimal(value);
}

function amountError(
  value: string,
  decimals: number,
  required: boolean,
): string | null {
  if (!value) return required ? 'Enter an amount' : null;

  const error = validateAmount(value, decimals, true);
  // A correctly formatted zero is a valid empty side for manual deposits.
  if (error === 'Amount must be greater than zero' && !required && isZeroDecimal(value)) {
    return null;
  }
  return error;
}

function hasPositiveAmount(value: string, decimals: number): boolean {
  if (!isPositiveDecimal(value)) return false;
  const error = amountError(value, decimals, true);
  return error === null;
}

/**
 * Auto-Fill has a single source side. When both sides are already valid and
 * positive, the draft is a manual two-token deposit until an amount edit
 * intentionally clears the other side.
 */
export function shouldUseAutoFillQuote(
  draft: MeteoraPositionDraft,
  tokenXDecimals: number,
  tokenYDecimals: number,
  addMode = false,
): boolean {
  if (addMode || !draft.autoFill || draft.fundingMode !== 'both') return false;
  const xPositive = hasPositiveAmount(draft.amountX, tokenXDecimals);
  const yPositive = hasPositiveAmount(draft.amountY, tokenYDecimals);
  return xPositive !== yPositive
    && (xPositive ? isEmptyTokenAmount(draft.amountY) : isEmptyTokenAmount(draft.amountX));
}

function rangeErrorForDraft(
  draft: MeteoraPositionDraft,
  poolState?: MeteoraExecutionPoolState | null,
  mode?: MeteoraPositionTokenMode,
): string | null {
  if (draft.preset !== 'manual') return null;
  if (!draft.requestedMinPrice) return 'Enter minimum price';
  if (!draft.requestedMaxPrice) return 'Enter maximum price';
  const basicError = validateRange(draft.requestedMinPrice, draft.requestedMaxPrice, true);
  if (basicError || !poolState) return basicError;
  try {
    const range = snapRangeToPoolState(poolState, {
      kind: 'manual', minPrice: draft.requestedMinPrice, maxPrice: draft.requestedMaxPrice,
    });
    const active = poolState.activeBinId;
    if ((mode === 'x_only' && range.maxBinId < active)
      || (mode === 'y_only' && range.minBinId > active)
      || (mode === 'both' && (range.minBinId > active || range.maxBinId < active))) {
      return mode === 'x_only'
        ? `${poolState.tokenX.symbol}-only range must overlap the active bin or bins above it`
        : mode === 'y_only'
          ? `${poolState.tokenY.symbol}-only range must overlap the active bin or bins below it`
          : 'A two-token range must include the active bin';
    }
  } catch (error) {
    return error instanceof Error ? error.message : 'Fix price range';
  }
  return null;
}

export function validateMeteoraPositionDraft({
  draft,
  tokenX,
  tokenY,
  addMode = false,
  poolState = null,
}: MeteoraPositionDraftValidationInput): MeteoraPositionDraftValidation {
  const autofill = draft.autoFill && draft.fundingMode === 'both' && !addMode;
  const single = draft.fundingMode === 'single' && !addMode;
  // Auto-Fill's source is a positive amount. A correctly formatted zero on the
  // opposite side is an unused side, while malformed text still gets validated.
  const xAutofillSource = autofill && hasPositiveAmount(draft.amountX, tokenX.decimals);
  const yAutofillSource = autofill && hasPositiveAmount(draft.amountY, tokenY.decimals);
  const xRequired = autofill
    ? xAutofillSource && !yAutofillSource
    : single
      ? draft.singleTokenSide === 'x'
      : false;
  const yRequired = autofill
    ? yAutofillSource && !xAutofillSource
    : single
      ? draft.singleTokenSide === 'y'
      : false;

  const amountXError = amountError(draft.amountX, tokenX.decimals, xRequired);
  const amountYError = amountError(draft.amountY, tokenY.decimals, yRequired);
  const xPositive = hasPositiveAmount(draft.amountX, tokenX.decimals);
  const yPositive = hasPositiveAmount(draft.amountY, tokenY.decimals);
  const hasAmount = xPositive || yPositive;

  // Add mode uses a fixed existing range and accepts either side, regardless of
  // the create-position Auto-Fill or single-token switches.
  // Auto-Fill and explicit single-token Zap both need an active-bin range;
  // otherwise use the exact local manual token-side mode.
  const mode = (autofill || single)
    ? 'both'
    : getPositionTokenMode(draft, tokenX.decimals, tokenY.decimals, addMode);
  const rangeError = addMode ? null : rangeErrorForDraft(draft, poolState, mode);

  let blockerLabel: string | null = null;
  if (amountXError) {
    blockerLabel = `Fix ${tokenX.symbol} amount`;
  } else if (amountYError) {
    blockerLabel = `Fix ${tokenY.symbol} amount`;
  } else if (!hasAmount) {
    blockerLabel = 'Enter an amount';
  } else {
    blockerLabel = rangeError
      ? (rangeError === 'Enter minimum price' || rangeError === 'Enter maximum price'
        ? rangeError
        : rangeError.includes('-only range') || rangeError.includes('two-token range')
          ? 'Adjust token range'
          : 'Fix price range')
      : null;
  }

  const valid = !amountXError
    && !amountYError
    && hasAmount
    && !rangeError;

  return {
    valid,
    amountXError,
    amountYError,
    rangeError,
    blockerLabel,
  };
}

export interface CreateManualPositionRequestInput {
  draft: MeteoraPositionDraft;
  poolAddress: string;
  range: MeteoraRangeRequest;
  tokenX: MeteoraValidationToken;
  tokenY: MeteoraValidationToken;
}

export function createManualPositionRequest({
  draft,
  poolAddress,
  range,
  tokenX,
  tokenY,
}: CreateManualPositionRequestInput): MeteoraCreatePositionRequest {
  if (draft.autoFill && shouldUseAutoFillQuote(draft, tokenX.decimals, tokenY.decimals)) {
    throw new Error('Manual position requests cannot use Auto-Fill');
  }
  if (draft.fundingMode === 'single') {
    throw new Error('Manual position requests cannot use single-token funding');
  }

  const validation = validateMeteoraPositionDraft({ draft, tokenX, tokenY });
  if (!validation.valid) {
    throw new Error(validation.blockerLabel ?? 'Fix position inputs');
  }

  const xPositive = hasPositiveAmount(draft.amountX, tokenX.decimals);
  const yPositive = hasPositiveAmount(draft.amountY, tokenY.decimals);
  if (xPositive && yPositive) {
    return {
      poolAddress,
      strategy: draft.strategy,
      range,
      depositMode: 'two_token',
      tokenXAmount: draft.amountX,
      tokenYAmount: draft.amountY,
    };
  }
  if (xPositive) {
    return {
      poolAddress,
      strategy: draft.strategy,
      range,
      depositMode: 'single_sided',
      inputToken: 'x',
      amount: draft.amountX,
    };
  }
  if (yPositive) {
    return {
      poolAddress,
      strategy: draft.strategy,
      range,
      depositMode: 'single_sided',
      inputToken: 'y',
      amount: draft.amountY,
    };
  }
  throw new Error('Enter an amount');
}
