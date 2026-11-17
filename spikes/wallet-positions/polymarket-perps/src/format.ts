import { absDecimal, formatPctFromDecimal, formatSignedUsd, formatUsd } from "./decimal.ts";
import type { ClassifiedFill, ReportedPosition, WalletSnapshot } from "./types.ts";

const ZONE = "Asia/Calcutta";

export function formatIst(ms: number | string | Date): string {
  const date = typeof ms === "number" || typeof ms === "string" ? new Date(ms) : ms;
  if (Number.isNaN(date.getTime())) return String(ms);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: ZONE,
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const grab = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${grab("day")} ${grab("month")} ${grab("year")} ${grab("hour")}:${grab("minute")}:${grab("second")} IST`;
}

function pad(value: string, width: number, align: "left" | "right" = "left"): string {
  if (value.length >= width) return value;
  const space = " ".repeat(width - value.length);
  return align === "right" ? space + value : value + space;
}

function formatPositionRow(position: ReportedPosition): string {
  const mark = position.mark_price ?? "n/a";
  const notional = position.notional !== null ? formatUsd(position.notional) : "n/a";
  const leverage = position.leverage !== null && position.leverage !== undefined ? `${position.leverage}x` : "n/a";
  const started =
    position.started_at !== null
      ? formatIst(position.started_at)
      : position.snapshot_status !== null
        ? `n/a (${position.snapshot_status})`
        : "n/a";
  return [
    pad(position.symbol, 14),
    pad(position.side.toUpperCase(), 5),
    pad(absDecimal(position.size), 14, "right"),
    pad(notional, 16, "right"),
    pad(position.entry_price, 14, "right"),
    pad(mark, 14, "right"),
    pad(formatSignedUsd(position.unrealized_pnl), 16, "right"),
    pad(formatPctFromDecimal(position.return_on_equity), 10, "right"),
    pad(leverage, 8, "right"),
    pad("n/a", 10, "right"),
    `  opened ${started}`,
  ].join(" ");
}

function formatFillRow(fill: ClassifiedFill): string {
  const flags = [
    fill.liquidation ? "liquidation" : "",
    fill.adl ? "ADL" : "",
    fill.settlement ? "settlement" : "",
    fill.taker ? "taker" : "maker",
  ]
    .filter((flag) => flag.length > 0)
    .join(", ");
  const pnl = formatSignedUsd(fill.pnl);
  return [
    formatIst(fill.timestamp),
    pad(fill.action.toUpperCase(), 9),
    pad(fill.symbol, 14),
    pad(fill.side.toUpperCase(), 5),
    pad(fill.quantity, 12, "right"),
    `@ ${fill.price}`,
    `prev ${fill.previous_size} -> ${fill.size_after}`,
    `pnl ${pnl}`,
    `fee ${formatUsd(fill.total_fee, 4)} ${fill.fee_asset}`,
    flags,
    `id ${fill.trade_id}`,
  ].join("  ");
}

export function formatReport(snapshot: WalletSnapshot): string {
  const lines: string[] = [];
  lines.push("Polymarket Perps wallet report");
  lines.push("Public read-only snapshot (prediction-market Data API is not used).");
  lines.push(`Wallet:     ${snapshot.wallet}`);
  lines.push(`Fetched:    ${formatIst(snapshot.fetched_at)}`);
  lines.push(`Registered: ${snapshot.registered ? "yes" : "no"}`);
  if (snapshot.account_error !== null) {
    lines.push(`Account:    ${snapshot.account_error}`);
  }
  lines.push("");
  lines.push("Account summary");
  lines.push("--------------");
  lines.push(
    `Equity: ${snapshot.equity !== null ? formatUsd(snapshot.equity) : "n/a"} (public portfolio equity in USD)`,
  );
  if (snapshot.portfolio_timestamp !== null) {
    lines.push(`Portfolio as of: ${formatIst(snapshot.portfolio_timestamp)}`);
  }
  if (snapshot.leaderboard_all !== null) {
    const row = snapshot.leaderboard_all;
    const rank = row.rank !== undefined ? `#${row.rank}` : "unranked (no activity in window, or no published equity)";
    lines.push(`Leaderboard (window=all, sort=pnl): rank ${rank}`);
    lines.push(
      `  realized PnL ${formatSignedUsd(row.pnl)}  volume ${formatUsd(row.notional)}  account value ${formatUsd(row.account_value)}  ROI ${formatPctFromDecimal(row.roi)}`,
    );
  }
  lines.push("Margin / withdrawable / in_liquidation / official liquidation price: not on the public API (owner-only GET /v1/account/portfolio).");
  if (snapshot.coverage !== undefined && snapshot.coverage !== null) {
    lines.push(
      `Coverage (undocumented public field): metadata_available=${String(snapshot.coverage.metadata_available)} collateral=${snapshot.coverage.collateral ?? "n/a"} missing_instrument_ids=${JSON.stringify(snapshot.coverage.missing_instrument_ids ?? [])}`,
    );
  }
  lines.push("");
  lines.push(`Open positions (${snapshot.positions.length})`);
  lines.push("--------------");
  if (snapshot.positions.length === 0) {
    lines.push(snapshot.registered ? "No open positions." : "No open positions — this address has no Polymarket Perps account.");
  } else {
    lines.push(
      [
        pad("Market", 14),
        pad("Side", 5),
        pad("Size", 14, "right"),
        pad("Notional", 16, "right"),
        pad("Entry", 14, "right"),
        pad("Mark", 14, "right"),
        pad("Unrealized PnL", 16, "right"),
        pad("ROE", 10, "right"),
        pad("Lev", 8, "right"),
        pad("Liq px", 10, "right"),
      ].join(" "),
    );
    for (const position of snapshot.positions) {
      lines.push(formatPositionRow(position));
    }
  }
  lines.push("");
  lines.push(`Recent fills (${snapshot.fills.length})`);
  lines.push("--------------");
  lines.push(snapshot.fills_window_note);
  if (snapshot.fills_truncated) {
    lines.push("More fills exist; output was capped by --fills-pages (100 fills per page).");
  }
  if (snapshot.fills.length === 0) {
    lines.push("No fills returned.");
  } else {
    for (const fill of snapshot.fills) {
      lines.push(formatFillRow(fill));
    }
  }
  lines.push("");
  lines.push("Limitations");
  lines.push("-----------");
  for (const item of snapshot.missing) {
    lines.push(`- ${item}`);
  }
  lines.push("");
  lines.push("Endpoints used");
  lines.push("--------------");
  for (const endpoint of snapshot.endpoints) {
    lines.push(`- ${endpoint}`);
  }
  return lines.join("\n");
}
