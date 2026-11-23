import { absDecimal, cmpDecimal, formatSignedUsd, formatUsd } from "./decimal.ts";
import type { ReportedPosition, WalletSnapshot } from "./types.ts";

export type PositionChange = {
  kind: "opened" | "closed" | "resized" | "flipped";
  symbol: string;
  instrument_id: number;
  detail: string;
  before?: ReportedPosition;
  after?: ReportedPosition;
};

export type SnapshotDiff = {
  wallet: { from: string; to: string };
  fetched_at: { from: string; to: string };
  equity: { from: string | null; to: string | null };
  changes: PositionChange[];
};

function key(position: ReportedPosition): number {
  return position.instrument_id;
}

function sizeLine(position: ReportedPosition): string {
  const notional = position.notional !== null ? `  notional ${formatUsd(position.notional)}` : "";
  const pnl = `  uPnL ${formatSignedUsd(position.unrealized_pnl)}`;
  return `${position.side.toUpperCase()} ${absDecimal(position.size)} ${position.symbol} @ ${position.entry_price}${notional}${pnl}`;
}

export function diffSnapshots(from: WalletSnapshot, to: WalletSnapshot): SnapshotDiff {
  const before = new Map(from.positions.map((p) => [key(p), p]));
  const after = new Map(to.positions.map((p) => [key(p), p]));
  const changes: PositionChange[] = [];
  const ids = new Set([...before.keys(), ...after.keys()]);

  for (const id of [...ids].sort((a, b) => a - b)) {
    const prev = before.get(id);
    const next = after.get(id);
    if (prev === undefined && next !== undefined) {
      changes.push({
        kind: "opened",
        symbol: next.symbol,
        instrument_id: id,
        detail: sizeLine(next),
        after: next,
      });
      continue;
    }
    if (prev !== undefined && next === undefined) {
      changes.push({
        kind: "closed",
        symbol: prev.symbol,
        instrument_id: id,
        detail: sizeLine(prev),
        before: prev,
      });
      continue;
    }
    if (prev === undefined || next === undefined) continue;
    if (prev.side !== next.side) {
      changes.push({
        kind: "flipped",
        symbol: next.symbol,
        instrument_id: id,
        detail: `${sizeLine(prev)}  ->  ${sizeLine(next)}`,
        before: prev,
        after: next,
      });
      continue;
    }
    if (cmpDecimal(prev.size, next.size) !== 0) {
      changes.push({
        kind: "resized",
        symbol: next.symbol,
        instrument_id: id,
        detail: `${sizeLine(prev)}  ->  ${sizeLine(next)}`,
        before: prev,
        after: next,
      });
    }
  }

  return {
    wallet: { from: from.wallet, to: to.wallet },
    fetched_at: { from: from.fetched_at, to: to.fetched_at },
    equity: { from: from.equity, to: to.equity },
    changes,
  };
}

export function formatDiff(diff: SnapshotDiff): string {
  const lines: string[] = [];
  lines.push("Polymarket Perps position diff");
  lines.push(`From: ${diff.fetched_at.from}  (${diff.wallet.from})`);
  lines.push(`To:   ${diff.fetched_at.to}  (${diff.wallet.to})`);
  const fromEq = diff.equity.from !== null ? formatUsd(diff.equity.from) : "n/a";
  const toEq = diff.equity.to !== null ? formatUsd(diff.equity.to) : "n/a";
  lines.push(`Equity: ${fromEq}  ->  ${toEq}`);
  lines.push("");
  if (diff.changes.length === 0) {
    lines.push("No opened, closed, flipped, or resized positions.");
    return lines.join("\n");
  }
  const counts = { opened: 0, closed: 0, resized: 0, flipped: 0 };
  for (const change of diff.changes) counts[change.kind] += 1;
  lines.push(
    `Changes: ${counts.opened} opened, ${counts.closed} closed, ${counts.resized} resized, ${counts.flipped} flipped`,
  );
  lines.push("");
  for (const change of diff.changes) {
    lines.push(`[${change.kind.toUpperCase()}] ${change.detail}`);
  }
  return lines.join("\n");
}
