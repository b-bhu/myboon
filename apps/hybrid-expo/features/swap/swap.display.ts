import { formatAtomicAmount } from '@/features/swap/swap.math';
import type { SwapOrderResponse, SwapToken } from '@/features/swap/swap.types';

export function exchangeRate(
  order: SwapOrderResponse | null,
  input: SwapToken,
  output: SwapToken,
): string {
  if (!order || order.inputMint !== input.address || order.outputMint !== output.address)
    return '—';
  const rate = exchangeRateValue(order, input, output);
  return rate !== null
    ? `1 ${input.symbol} = ${rate.toLocaleString('en-US', { maximumSignificantDigits: 8 })} ${output.symbol}`
    : 'Unavailable';
}

/** Returns the pair rate for numeric consumers such as compact inline metrics. */
export function exchangeRateValue(
  order: SwapOrderResponse | null,
  input: SwapToken,
  output: SwapToken,
): number | null {
  if (!order || order.inputMint !== input.address || order.outputMint !== output.address) return null;
  const pay = Number(formatAtomicAmount(order.inAmountAtomic, input.decimals, input.decimals));
  const receive = Number(
    formatAtomicAmount(order.outAmountAtomic, output.decimals, output.decimals),
  );
  const rate = receive / pay;
  return pay > 0 && Number.isFinite(rate) ? rate : null;
}

/** Formats an atomic balance without converting it through JavaScript's lossy Number type. */
export function formatBalance(value: string | undefined, decimals: number): string {
  if (
    value === undefined ||
    !/^\d+$/.test(value) ||
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 18
  ) {
    return '—';
  }

  const atomic = BigInt(value);
  const base = 10n ** BigInt(decimals);
  const whole = atomic / base;
  const fraction = (atomic % base).toString().padStart(decimals, '0');
  return `${whole}.${fraction.slice(0, 3).padEnd(3, '0')}`;
}

export function providerFee(order: SwapOrderResponse, input: SwapToken, output: SwapToken): string {
  const { providerFeeAtomic: fee, providerFeeMint: mint } = order.fees;
  if (fee === null) return 'Unavailable';
  if (fee === '0') return '0';
  const asset = [input, output].find((token) => token.address === mint);
  return asset
    ? `${formatAtomicAmount(fee, asset.decimals, 8)} ${asset.symbol}`
    : `${fee} atomic units · ${mint ?? 'mint unavailable'}`;
}
