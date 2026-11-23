import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { classifyFills } from "./classify.ts";
import {
  fetchLeaderboardAccount,
  fetchPositionSnapshots,
  fetchPublicFills,
  fetchPublicPortfolio,
  fetchRegistered,
  fetchTickers,
  isAccountNotFound,
  PerpsHttpError,
} from "./client.ts";
import { absDecimal, mulDecimal, signDecimal } from "./decimal.ts";
import { diffSnapshots, formatDiff } from "./diff.ts";
import { formatReport } from "./format.ts";
import { PERPS_HTTP_BASE, type PublicPortfolioPosition, type ReportedPosition, type PositionSnapshotResult, type WalletSnapshot } from "./types.ts";

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

const PUBLIC_ENDPOINTS = [
  `GET ${PERPS_HTTP_BASE}/v1/info/registered?address=`,
  `GET ${PERPS_HTTP_BASE}/v1/info/portfolio?address=`,
  `GET ${PERPS_HTTP_BASE}/v1/info/tickers`,
  `GET ${PERPS_HTTP_BASE}/v1/info/fills?address=&sort=desc`,
  `POST ${PERPS_HTTP_BASE}/v1/info/position-snapshots`,
  `GET ${PERPS_HTTP_BASE}/v1/info/leaderboard?window=all&sort_by=pnl&limit=1&address=`,
];

const MISSING_NOTES = [
  "Liquidation price, margin summary, withdrawable balance, and in_liquidation are documented only on the owner-authenticated GET /v1/account/portfolio — not on the public portfolio.",
  "Public fills default to a 30-day window, 100 rows per page, and omit builder identity/rate. Instrument-filtered history is capped at 250,000 physical rows (HTTP 413 if exceeded).",
  "IP rate limit: 1,000 weighted tokens per minute. Public portfolio weight 5, tickers 2, fills 10 (1 if cached 2s), position-snapshots max(10, active + 7×history), leaderboard 5 (1 if cached 5s).",
  "Position snapshot requests take at most 20 instrument IDs at a time. Docs say leverage and pnl_percent are null for anonymous/other-account callers; the script still displays them when the API returns values.",
  "This POC does not use WebSockets or any authenticated session, key, or secret.",
];

type ReportArgs = {
  mode: "report";
  address: string;
  outDir: string;
  fillsPages: number;
  jsonOnly: boolean;
};

type DiffArgs = {
  mode: "diff";
  fromPath: string;
  toPath: string;
};

type CliArgs = ReportArgs | DiffArgs;

function usage(): string {
  return `Usage:
  npx tsx src/report.ts [--out DIR] [--fills-pages N] [--json] <wallet>
  npx tsx src/report.ts --diff <old.json> <new.json>

Read-only public Polymarket Perps report for a wallet. No API key required.`;
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) {
    throw new Error(usage());
  }
  const diffAt = args.indexOf("--diff");
  if (diffAt !== -1) {
    const fromPath = args[diffAt + 1];
    const toPath = args[diffAt + 2];
    if (fromPath === undefined || toPath === undefined) {
      throw new Error(usage());
    }
    return { mode: "diff", fromPath, toPath };
  }
  let outDir = path.join(process.cwd(), "snapshots");
  let fillsPages = 3;
  let jsonOnly = false;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === "--out") {
      const value = args[i + 1];
      if (value === undefined) throw new Error("--out requires a directory");
      outDir = value;
      i += 1;
      continue;
    }
    if (token === "--fills-pages") {
      const value = args[i + 1];
      if (value === undefined) throw new Error("--fills-pages requires a number");
      fillsPages = Number(value);
      if (!Number.isInteger(fillsPages) || fillsPages < 1 || fillsPages > 50) {
        throw new Error("--fills-pages must be an integer from 1 to 50");
      }
      i += 1;
      continue;
    }
    if (token === "--json") {
      jsonOnly = true;
      continue;
    }
    if (token !== undefined) rest.push(token);
  }
  const address = rest[0];
  if (address === undefined || rest.length !== 1 || !ADDRESS_RE.test(address)) {
    throw new Error(`Expected a single 0x + 40 hex wallet address.\n\n${usage()}`);
  }
  return { mode: "report", address, outDir, fillsPages, jsonOnly };
}

function sideFromSize(size: string): "long" | "short" {
  return signDecimal(size) < 0 ? "short" : "long";
}

async function buildSnapshot(address: string, fillsPages: number): Promise<WalletSnapshot> {
  const fetchedAt = new Date().toISOString();
  const registered = await fetchRegistered(address);
  let accountError: string | null = null;
  let equity: string | null = null;
  let portfolioTimestamp: number | null = null;
  let coverage: WalletSnapshot["coverage"] = null;
  let rawPositions: PublicPortfolioPosition[] = [];

  try {
    const portfolio = await fetchPublicPortfolio(address);
    equity = portfolio.equity;
    portfolioTimestamp = portfolio.timestamp;
    coverage = portfolio.coverage ?? null;
    rawPositions = portfolio.positions;
  } catch (error) {
    if (isAccountNotFound(error)) {
      accountError = "account not found (address is not registered on Polymarket Perps)";
    } else {
      throw error;
    }
  }

  const tickers = await fetchTickers();
  const tickerById = new Map(tickers.map((ticker) => [ticker.instrument_id, ticker]));
  const symbols = new Map<number, string>();
  for (const ticker of tickers) symbols.set(ticker.instrument_id, ticker.symbol);
  for (const position of rawPositions) symbols.set(position.instrument_id, position.symbol);

  const snapshotById = new Map<number, PositionSnapshotResult>();
  if (rawPositions.length > 0) {
    const cards = await fetchPositionSnapshots(
      address,
      rawPositions.map((position) => position.instrument_id),
    );
    for (const item of cards.active) {
      if (item.instrument_id !== undefined) snapshotById.set(item.instrument_id, item);
    }
  }

  const positions: ReportedPosition[] = rawPositions.map((position) => {
    const ticker = tickerById.get(position.instrument_id);
    const card = snapshotById.get(position.instrument_id);
    const mark = card?.snapshot?.as_of_price ?? ticker?.mark_price ?? null;
    const notional = mark !== null ? mulDecimal(absDecimal(position.size), mark) : null;
    const leverage = position.leverage ?? card?.snapshot?.leverage ?? null;
    return {
      instrument_id: position.instrument_id,
      symbol: position.symbol,
      side: card?.snapshot?.side ?? sideFromSize(position.size),
      size: position.size,
      abs_size: absDecimal(position.size),
      entry_price: position.entry_price,
      mark_price: mark,
      notional,
      unrealized_pnl: position.unrealized_pnl,
      return_on_equity: position.return_on_equity,
      leverage,
      liquidation_price: null,
      started_at: card?.snapshot?.started_at ?? null,
      snapshot_status: card?.status ?? null,
    };
  });

  let fills: WalletSnapshot["fills"] = [];
  let fillsTruncated = false;
  if (registered || accountError === null) {
    try {
      const page = await fetchPublicFills(address, fillsPages);
      fills = classifyFills(page.fills, symbols);
      fillsTruncated = page.truncated;
    } catch (error) {
      if (isAccountNotFound(error)) {
        accountError ??= "account not found (address is not registered on Polymarket Perps)";
      } else {
        throw error;
      }
    }
  }

  let leaderboardAll: WalletSnapshot["leaderboard_all"] = null;
  try {
    leaderboardAll = await fetchLeaderboardAccount(address);
  } catch (error) {
    if (!(error instanceof PerpsHttpError && error.status === 503)) throw error;
  }

  return {
    fetched_at: fetchedAt,
    wallet: address,
    registered,
    account_error: accountError,
    equity,
    portfolio_timestamp: portfolioTimestamp,
    coverage,
    leaderboard_all: leaderboardAll,
    positions,
    fills,
    fills_truncated: fillsTruncated,
    fills_window_note:
      "Public fills default window starts 30 days before request time; this report uses sort=desc and up to --fills-pages pages of 100 fills.",
    missing: MISSING_NOTES,
    endpoints: PUBLIC_ENDPOINTS,
  };
}

async function writeSnapshot(outDir: string, snapshot: WalletSnapshot): Promise<string> {
  await mkdir(outDir, { recursive: true });
  const stamp = snapshot.fetched_at.replaceAll(":", "").replaceAll("-", "").replace(".000Z", "Z");
  const file = path.join(outDir, `${snapshot.wallet.toLowerCase()}-${stamp}.json`);
  await writeFile(file, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  return file;
}

async function readSnapshot(filePath: string): Promise<WalletSnapshot> {
  const raw = JSON.parse(await readFile(filePath, "utf8")) as unknown;
  if (typeof raw !== "object" || raw === null || !("wallet" in raw) || !("positions" in raw)) {
    throw new Error(`Not a wallet snapshot: ${filePath}`);
  }
  return raw as WalletSnapshot;
}

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 2;
    return;
  }

  if (args.mode === "diff") {
    const from = await readSnapshot(args.fromPath);
    const to = await readSnapshot(args.toPath);
    process.stdout.write(`${formatDiff(diffSnapshots(from, to))}\n`);
    return;
  }

  const snapshot = await buildSnapshot(args.address, args.fillsPages);
  const file = await writeSnapshot(args.outDir, snapshot);
  if (args.jsonOnly) {
    process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatReport(snapshot)}\n`);
    process.stdout.write(`\nJSON snapshot saved to ${file}\n`);
  }
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
