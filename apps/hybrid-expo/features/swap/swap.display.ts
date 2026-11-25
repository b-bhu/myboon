import { formatAtomicAmount } from '@/features/swap/swap.math';
import type { SwapOrderResponse, SwapToken } from '@/features/swap/swap.types';

/** Fee split shown behind the slider's "i" button: execution, app and swap cost. */
export interface SwapSliderFeeSplit {
  execution: string;
  app: string;
  swap: string;
}

export interface SwapSliderCopy {
  small: string;
  strong: string;
  /** Fee-split line for the "i" button, or null when there is nothing to disclose. */
  feeSplit: string | null;
}

export type SwapSliderCopyInput =
  | {
      state: 'idle';
      /** Route summary, e.g. 'Jupiter' or 'Solana → Base'. */
      route?: string | null;
      /** Same-chain rate line, e.g. '1 SOL = 142.3 USDC'. Takes precedence over fees/time. */
      rate?: string | null;
      /** Preformatted total fees, e.g. '$0.02'. Rendered as '$0.02 fees'. */
      fees?: string | null;
      /** Preformatted time estimate, e.g. '~2 min'. */
      time?: string | null;
      /** Strong line: the action, e.g. 'Swipe to swap 1 SOL → 142.3 USDC'. */
      action: string;
      feeSplit?: SwapSliderFeeSplit | null;
    }
  | { state: 'pending'; step: number; stepCount: number; stepLabel: string }
  | { state: 'done'; fees: string; time: string; received: string }
  | { state: 'failed'; step: number; stepCount: number }
  | { state: 'no-route'; reason: string; suggestion?: string | null };

function formatFeeSplit(split?: SwapSliderFeeSplit | null): string | null {
  if (!split) return null;
  return `Exec ${split.execution} · App ${split.app} · Swap ${split.swap}`;
}

/**
 * Two-line copy for the swap slider, per the wiki status table:
 * idle shows route, fees and time (or the rate for a same-chain swap) plus the
 * action; pending and failed name the step; done shows fees and time; no route
 * shows the reason.
 */
export function swapSliderCopy(input: SwapSliderCopyInput): SwapSliderCopy {
  switch (input.state) {
    case 'idle': {
      const parts = [input.route?.trim() || null];
      if (input.rate) {
        parts.push(input.rate);
      } else {
        if (input.fees) parts.push(`${input.fees} fees`);
        if (input.time) parts.push(input.time);
      }
      const small = parts.filter(Boolean).join(' · ') || 'Route and fees update with the quote';
      return { small, strong: input.action, feeSplit: formatFeeSplit(input.feeSplit) };
    }
    case 'pending':
      return {
        small: `Step ${input.step} of ${input.stepCount}`,
        strong: input.stepLabel,
        feeSplit: null,
      };
    case 'done':
      return {
        small: `Done · ${input.fees} fees · took ${input.time}`,
        strong: `+${input.received} received`,
        feeSplit: null,
      };
    case 'failed':
      return {
        small: `Step ${input.step} of ${input.stepCount} failed · money is safe`,
        strong: `Tap to retry step ${input.step}`,
        feeSplit: null,
      };
    case 'no-route':
      return {
        small: `No route · ${input.reason}`,
        strong: input.suggestion ? `Tap to use ${input.suggestion}` : 'Tap to switch to a supported chain',
        feeSplit: null,
      };
  }
}

/** One-line receipt shown in place of the facts row after a Swap completes. */
export function swapReceiptLine(input: { sent: string; got: string; time: string }): string {
  return `Receipt: sent ${input.sent} · got ${input.got} · ${input.time}`;
}

/** "4s" under a minute, "1m 5s" above; "—" when the start was not seen. */
export function formatTook(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '—';
  const seconds = Math.max(1, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

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
