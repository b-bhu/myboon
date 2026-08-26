export interface MinimumOrderGuardrail {
  blocking: true;
  title: string;
  message: string;
}

function formatShares(value: number): string {
  return value.toLocaleString('en-US', { maximumFractionDigits: 4 });
}

function formatRequiredSpend(value: number): string {
  // Never understate the amount needed because the composer only accepts cents.
  return `$${(Math.ceil(value * 100) / 100).toFixed(2)}`;
}

/**
 * Polymarket expresses its market minimum in outcome shares, not dollars.
 * The minimum is market metadata and must never be invented by the client.
 */
export function getMinimumOrderGuardrail(params: {
  orderSize: number | null;
  minimumOrderSize: number | null | undefined;
  executionPrice: number | null;
}): MinimumOrderGuardrail | null {
  const { orderSize, minimumOrderSize, executionPrice } = params;
  if (
    minimumOrderSize === null
    || minimumOrderSize === undefined
    || !Number.isFinite(minimumOrderSize)
    || minimumOrderSize <= 0
  ) {
    return null;
  }
  if (orderSize === null || !Number.isFinite(orderSize) || orderSize <= 0) return null;
  if (orderSize + 0.000001 >= minimumOrderSize) return null;

  const sharesLabel = `${formatShares(minimumOrderSize)} ${minimumOrderSize === 1 ? 'share' : 'shares'}`;
  const requiredSpend = executionPrice !== null
    && Number.isFinite(executionPrice)
    && executionPrice > 0
    && executionPrice < 1
    ? formatRequiredSpend(minimumOrderSize * executionPrice)
    : null;

  return {
    blocking: true,
    title: 'Below market minimum',
    message: requiredSpend
      ? `This market requires at least ${sharesLabel} (about ${requiredSpend} at this price).`
      : `This market requires at least ${sharesLabel}.`,
  };
}
