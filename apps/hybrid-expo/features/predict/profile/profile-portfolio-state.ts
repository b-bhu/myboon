import type { OpenOrder } from '@/features/predict/predict.api';

export function remainingOrderShares(order: OpenOrder): number | null {
  const original = Number.parseFloat(order.original_size);
  const matched = Number.parseFloat(order.size_matched);
  if (!Number.isFinite(original) || !Number.isFinite(matched)) return null;
  return Math.max(original - matched, 0);
}

export function remainingOrderCost(order: OpenOrder): number | null {
  const shares = remainingOrderShares(order);
  const price = Number.parseFloat(order.price);
  if (shares === null || !Number.isFinite(price)) return null;
  return shares * price;
}
