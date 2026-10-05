import type { MeteoraPositionDraft } from './meteora.form';
import { getPositionTokenMode } from './meteora.position-range';

export interface MeteoraPositionCostShape {
  depositMode: 'two_token' | 'single_sided';
  inputToken: 'x' | 'y';
}

/**
 * The read-only native-cost quote must use the same transaction shape as the
 * eventual create preview. Auto-Fill starts with one editable source amount,
 * but it creates a two-token position after its quote resolves.
 */
export function getMeteoraPositionCostShape(
  draft: MeteoraPositionDraft,
  tokenXDecimals = 9,
  tokenYDecimals = 6,
): MeteoraPositionCostShape {
  const mode = getPositionTokenMode(draft, tokenXDecimals, tokenYDecimals);
  if (mode === 'x_only') return { depositMode: 'single_sided', inputToken: 'x' };
  if (mode === 'y_only') return { depositMode: 'single_sided', inputToken: 'y' };
  return { depositMode: 'two_token', inputToken: 'x' };
}

export interface MeteoraPositionCostKeyInput extends MeteoraPositionCostShape {
  poolAddress?: string;
  walletAddress?: string | null;
  freshness?: string;
  minPrice: string;
  maxPrice: string;
  strategy: string;
  retry: number;
}

/** Keep a completed estimate only while every transaction-shape input matches. */
export function createMeteoraPositionCostKey(input: MeteoraPositionCostKeyInput): string {
  return JSON.stringify({
    pool: input.poolAddress,
    wallet: input.walletAddress,
    freshness: input.freshness,
    min: input.minPrice,
    max: input.maxPrice,
    strategy: input.strategy,
    inputToken: input.inputToken,
    depositMode: input.depositMode,
    retry: input.retry,
  });
}
