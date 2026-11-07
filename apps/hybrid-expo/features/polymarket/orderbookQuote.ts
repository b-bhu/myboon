import type { Orderbook, OrderbookLevel } from '@/features/polymarket/polymarket.types';

export interface ExecutableBuyQuote {
  executable: boolean;
  amount: number;
  shares: number;
  averagePrice: number | null;
  limitPrice: number | null;
  bestAsk: number | null;
  estimatedCost: number;
  unfilledAmount: number;
}

export interface ExecutableSellQuote {
  executable: boolean;
  requestedShares: number;
  filledShares: number;
  averagePrice: number | null;
  limitPrice: number | null;
  bestBid: number | null;
  estimatedProceeds: number;
  unfilledShares: number;
}

function sortedAsks(book: Orderbook | null): OrderbookLevel[] {
  return [...(book?.asks ?? [])]
    .filter((level) => Number.isFinite(level.price) && level.price > 0 && Number.isFinite(level.size) && level.size > 0)
    .sort((a, b) => a.price - b.price);
}

function sortedBids(book: Orderbook | null): OrderbookLevel[] {
  return [...(book?.bids ?? [])]
    .filter((level) => Number.isFinite(level.price) && level.price > 0 && Number.isFinite(level.size) && level.size > 0)
    .sort((a, b) => b.price - a.price);
}

export function getBestAsk(book: Orderbook | null): number | null {
  const asks = sortedAsks(book);
  return asks[0]?.price ?? null;
}

export function getBestBid(book: Orderbook | null): number | null {
  const bids = sortedBids(book);
  return bids[0]?.price ?? null;
}

export function buildExecutableBuyQuote(book: Orderbook | null, amount: number): ExecutableBuyQuote {
  const asks = sortedAsks(book);
  const bestAsk = asks[0]?.price ?? null;
  if (!Number.isFinite(amount) || amount <= 0 || asks.length === 0) {
    return {
      executable: false,
      amount,
      shares: 0,
      averagePrice: null,
      limitPrice: null,
      bestAsk,
      estimatedCost: 0,
      unfilledAmount: Math.max(amount, 0),
    };
  }

  let remaining = amount;
  let shares = 0;
  let estimatedCost = 0;
  let limitPrice: number | null = null;

  for (const ask of asks) {
    if (remaining <= 0) break;
    const levelCost = ask.price * ask.size;
    const costAtLevel = Math.min(remaining, levelCost);
    const sharesAtLevel = Math.floor((costAtLevel / ask.price) * 100) / 100;
    if (sharesAtLevel <= 0) break;

    const consumedCost = sharesAtLevel * ask.price;
    shares += sharesAtLevel;
    estimatedCost += consumedCost;
    remaining -= consumedCost;
    limitPrice = ask.price;
  }

  const roundedShares = Math.floor(shares * 100) / 100;
  const roundedCost = Math.round(estimatedCost * 100) / 100;
  const unfilledAmount = Math.max(0, amount - roundedCost);

  return {
    executable: roundedShares > 0 && unfilledAmount <= 0.02 && limitPrice !== null,
    amount,
    shares: roundedShares,
    averagePrice: roundedShares > 0 ? roundedCost / roundedShares : null,
    limitPrice,
    bestAsk,
    estimatedCost: roundedCost,
    unfilledAmount,
  };
}

export function buildExecutableSellQuote(book: Orderbook | null, sharesToSell: number): ExecutableSellQuote {
  const bids = sortedBids(book);
  const bestBid = bids[0]?.price ?? null;
  if (!Number.isFinite(sharesToSell) || sharesToSell <= 0 || bids.length === 0) {
    return {
      executable: false,
      requestedShares: Math.max(sharesToSell, 0),
      filledShares: 0,
      averagePrice: null,
      limitPrice: null,
      bestBid,
      estimatedProceeds: 0,
      unfilledShares: Math.max(sharesToSell, 0),
    };
  }

  let remainingShares = sharesToSell;
  let filledShares = 0;
  let estimatedProceeds = 0;
  let limitPrice: number | null = null;

  for (const bid of bids) {
    if (remainingShares <= 0) break;
    const sharesAtLevel = Math.min(remainingShares, bid.size);
    if (sharesAtLevel <= 0) break;

    filledShares += sharesAtLevel;
    estimatedProceeds += sharesAtLevel * bid.price;
    remainingShares -= sharesAtLevel;
    limitPrice = bid.price;
  }

  const roundedFilledShares = Math.floor(filledShares * 100) / 100;
  const roundedProceeds = Math.round(estimatedProceeds * 100) / 100;
  const unfilledShares = Math.max(0, sharesToSell - roundedFilledShares);

  return {
    executable: roundedFilledShares > 0 && unfilledShares <= 0.01 && limitPrice !== null,
    requestedShares: sharesToSell,
    filledShares: roundedFilledShares,
    averagePrice: roundedFilledShares > 0 ? roundedProceeds / roundedFilledShares : null,
    limitPrice,
    bestBid,
    estimatedProceeds: roundedProceeds,
    unfilledShares,
  };
}
