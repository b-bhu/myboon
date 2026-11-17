import { absDecimal, addDecimal, cmpDecimal, signDecimal } from "./decimal.ts";
import type { AccountTrade, ClassifiedFill, FillAction } from "./types.ts";

export function sizeAfterFill(trade: AccountTrade): string {
  const delta = trade.side === "long" ? trade.quantity : `-${absDecimal(trade.quantity)}`;
  return addDecimal(trade.previous_size, delta);
}

export function classifyFill(trade: AccountTrade): FillAction {
  const afterSize = sizeAfterFill(trade);
  const before = signDecimal(trade.previous_size);
  const after = signDecimal(afterSize);
  if (before === 0 && after !== 0) return "open";
  if (before !== 0 && after === 0) return "close";
  if (before !== 0 && after !== 0 && before !== after) return "flip";
  if (cmpDecimal(absDecimal(afterSize), absDecimal(trade.previous_size)) > 0) return "increase";
  return "reduce";
}

export function classifyFills(trades: AccountTrade[], symbols: Map<number, string>): ClassifiedFill[] {
  return trades.map((trade) => ({
    ...trade,
    symbol: symbols.get(trade.instrument_id) ?? `#${trade.instrument_id}`,
    size_after: sizeAfterFill(trade),
    action: classifyFill(trade),
  }));
}
