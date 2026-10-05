import { formatAtomicAmount } from '@/features/swap/swap.math';
import type { SwapOrderResponse, SwapToken } from '@/features/swap/swap.types';

export function exchangeRate(
  order: SwapOrderResponse | null,
  input: SwapToken,
  output: SwapToken,
): string {
  if (!order || order.inputMint !== input.address || order.outputMint !== output.address)
    return '—';
  const pay = Number(formatAtomicAmount(order.inAmountAtomic, input.decimals, input.decimals));
  const receive = Number(
    formatAtomicAmount(order.outAmountAtomic, output.decimals, output.decimals),
  );
  const rate = receive / pay;
  return pay > 0 && Number.isFinite(rate)
    ? `1 ${input.symbol} = ${rate.toLocaleString('en-US', { maximumSignificantDigits: 8 })} ${output.symbol}`
    : 'Unavailable';
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
