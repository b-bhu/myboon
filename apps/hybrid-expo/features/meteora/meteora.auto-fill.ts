import {
  decimalToAtomic,
  isPositiveDecimal,
  type MeteoraAutoFillAmounts,
  type MeteoraPositionDraft,
} from './meteora.form';
import type { MeteoraSdkClient } from '@myboon/shared/meteora';
import {
  shouldUseAutoFillQuote,
  validateMeteoraPositionDraft,
} from './meteora.position-validation';

/** Display only: range/strategy estimate while the live active-bin quote is unavailable. */
export function estimateAutoFillAmounts({
  draft,
  currentPrice,
  binStep,
  tokenXDecimals,
  tokenYDecimals,
}: {
  draft: MeteoraPositionDraft;
  currentPrice: string | null;
  binStep: number;
  tokenXDecimals: number;
  tokenYDecimals: number;
}): MeteoraAutoFillAmounts | null {
  if (!draft.autoFill || draft.fundingMode !== 'both'
    || !currentPrice || !Number.isSafeInteger(binStep) || binStep < 1
    || ![tokenXDecimals, tokenYDecimals].every((value) => Number.isInteger(value) && value >= 0 && value <= 18)) {
    return null;
  }
  if (!shouldUseAutoFillQuote(draft, tokenXDecimals, tokenYDecimals)) return null;
  if (!validateMeteoraPositionDraft({
    draft,
    tokenX: { symbol: 'token X', decimals: tokenXDecimals },
    tokenY: { symbol: 'token Y', decimals: tokenYDecimals },
  }).valid) return null;
  const price = positiveDecimalFraction(currentPrice);
  const min = positiveDecimalFraction(draft.requestedMinPrice);
  const max = positiveDecimalFraction(draft.requestedMaxPrice);
  if (!price || !min || !max
    || price.numerator * min.denominator <= min.numerator * price.denominator
    || price.numerator * max.denominator >= max.numerator * price.denominator) return null;

  const weights = estimateRangeWeights(draft, currentPrice, binStep);
  if (!weights) return null;

  try {
    const inputSide = isPositiveDecimal(draft.amountX) ? 'x' : 'y';
    const inputDecimals = inputSide === 'x' ? tokenXDecimals : tokenYDecimals;
    const outputDecimals = inputSide === 'x' ? tokenYDecimals : tokenXDecimals;
    const inputAtomic = BigInt(decimalToAtomic(inputSide === 'x' ? draft.amountX : draft.amountY, inputDecimals));
    const outputAtomic = inputSide === 'x'
      ? (inputAtomic * price.numerator * weights.y * (10n ** BigInt(outputDecimals)))
        / (price.denominator * weights.x * (10n ** BigInt(inputDecimals)))
      : (inputAtomic * price.denominator * weights.x * (10n ** BigInt(outputDecimals)))
        / (price.numerator * weights.y * (10n ** BigInt(inputDecimals)));
    if (outputAtomic <= 0n || outputAtomic > (1n << 64n) - 1n) return null;
    const output = formatAtomic(outputAtomic, outputDecimals);
    return inputSide === 'x'
      ? { amountX: draft.amountX, amountY: output }
      : { amountX: output, amountY: draft.amountY };
  } catch {
    return null;
  }
}

/**
 * Match the SDK's Auto-Fill strategy weights in relative bins. Unknown active
 * reserves use a half split; the live quote replaces this display estimate.
 * Fixed-point weights keep large atomic inputs out of floating-point arithmetic.
 */
function estimateRangeWeights(draft: MeteoraPositionDraft, currentPrice: string, binStep: number) {
  const price = Number(currentPrice);
  const step = Math.log1p(binStep / 10_000);
  const minOffset = Math.log(Number(draft.requestedMinPrice) / price) / step;
  const maxOffset = Math.log(Number(draft.requestedMaxPrice) / price) / step;
  if (!Number.isFinite(minOffset) || !Number.isFinite(maxOffset)) return null;
  const minBin = Math.floor(minOffset + 1e-9);
  const maxBin = Math.ceil(maxOffset - 1e-9);
  if (minBin >= 0 || maxBin <= 0 || maxBin - minBin + 1 > 4_096) return null;

  const scale = 10n ** 30n;
  const activeWeight = draft.strategy === 'spot' ? 1 : draft.strategy === 'curve' ? 2_000 : 200;
  let x = BigInt(activeWeight) * scale / 2n;
  let y = x;
  const weight = (distance: number, count: number) => {
    if (draft.strategy === 'spot') return 1;
    const slope = Math.floor(1_800 / count);
    return draft.strategy === 'curve' ? 2_000 - distance * slope : 200 + distance * slope;
  };
  for (let distance = 1; distance <= -minBin; distance += 1) {
    y += BigInt(weight(distance, -minBin)) * scale;
  }
  let inverseRelativePrice = scale;
  const factor = 10_000n + BigInt(binStep);
  for (let distance = 1; distance <= maxBin; distance += 1) {
    inverseRelativePrice = inverseRelativePrice * 10_000n / factor;
    x += BigInt(weight(distance, maxBin)) * inverseRelativePrice;
  }
  return x > 0n && y > 0n ? { x, y } : null;
}

function positiveDecimalFraction(value: string): { numerator: bigint; denominator: bigint } | null {
  if (value.length > 128) return null;
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(value);
  if (!match) return null;
  const exponent = Number(match[3] ?? 0);
  if (!Number.isInteger(exponent) || Math.abs(exponent) > 100) return null;
  const fraction = match[2] ?? '';
  const scale = fraction.length - exponent;
  const digits = BigInt(`${match[1]}${fraction}`);
  if (digits <= 0n) return null;
  return scale >= 0
    ? { numerator: digits, denominator: 10n ** BigInt(scale) }
    : { numerator: digits * (10n ** BigInt(-scale)), denominator: 1n };
}

function formatAtomic(value: bigint, decimals: number): string {
  const padded = value.toString().padStart(decimals + 1, '0');
  if (decimals === 0) return padded;
  const fraction = padded.slice(-decimals).replace(/0+$/, '');
  return fraction ? `${padded.slice(0, -decimals)}.${fraction}` : padded.slice(0, -decimals);
}

export type MeteoraAutoFillSdk = Pick<
  MeteoraSdkClient,
  'quoteAutoFill' | 'previewCreatePosition'
>;

export async function prepareAutoFillPosition(
  sdk: MeteoraAutoFillSdk,
  request: Parameters<MeteoraSdkClient['quoteAutoFill']>[0],
  onQuote?: (amounts: MeteoraAutoFillAmounts) => void,
): Promise<Awaited<ReturnType<MeteoraSdkClient['previewCreatePosition']>>> {
  const quote = await sdk.quoteAutoFill(request);
  onQuote?.({
    amountX: quote.tokenXAmount,
    amountY: quote.tokenYAmount,
  });

  return sdk.previewCreatePosition({
    poolAddress: request.poolAddress,
    strategy: request.strategy,
    range: request.range,
    depositMode: 'two_token',
    tokenXAmount: quote.tokenXAmount,
    tokenYAmount: quote.tokenYAmount,
  });
}
