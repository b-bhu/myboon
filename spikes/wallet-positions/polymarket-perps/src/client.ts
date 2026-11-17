import { PERPS_HTTP_BASE, type AccountTrade, type AccountTrades, type ApiErrorBody, type Leaderboard, type LeaderboardAccount, type PositionSnapshots, type PublicPortfolio, type RegisteredResponse, type Ticker } from "./types.ts";

export class PerpsHttpError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.name = "PerpsHttpError";
    this.status = status;
    this.body = body;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isApiErrorBody(value: unknown): value is ApiErrorBody {
  return isRecord(value) && value.status === "err" && typeof value.error === "string";
}

/**
 * The fills API may return trade_id / order_id as JSON numbers. Docs require
 * keeping UInt64 trade IDs as decimal strings and never rounding them through
 * a JavaScript number.
 */
export function parseJsonSafeIntegers(text: string, keys: readonly string[]): unknown {
  const pattern = new RegExp(`"(${keys.join("|")})"\\s*:\\s*(-?\\d+)`, "g");
  return JSON.parse(text.replace(pattern, `"$1":"$2"`)) as unknown;
}

export async function perpsGet(path: string, query?: Record<string, string>): Promise<{ status: number; json: unknown; text: string }> {
  const url = new URL(path, PERPS_HTTP_BASE);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
  }
  const response = await fetch(url, { method: "GET", headers: { accept: "application/json" } });
  const text = await response.text();
  let json: unknown;
  try {
    json = parseJsonSafeIntegers(text, ["trade_id", "order_id"]);
  } catch {
    json = text;
  }
  return { status: response.status, json, text };
}

export async function perpsPost(path: string, body: unknown): Promise<{ status: number; json: unknown; text: string }> {
  const url = new URL(path, PERPS_HTTP_BASE);
  const response = await fetch(url, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json: unknown;
  try {
    json = parseJsonSafeIntegers(text, ["trade_id", "order_id"]);
  } catch {
    json = text;
  }
  return { status: response.status, json, text };
}

function expectOk<T>(status: number, json: unknown, label: string): T {
  if (status !== 200) {
    const detail = isApiErrorBody(json) ? json.error : JSON.stringify(json);
    throw new PerpsHttpError(status, json, `${label} failed: HTTP ${status} ${detail}`);
  }
  return json as T;
}

export function isAccountNotFound(error: unknown): boolean {
  return (
    error instanceof PerpsHttpError &&
    isApiErrorBody(error.body) &&
    error.body.error === "account not found"
  );
}

export async function fetchRegistered(address: string): Promise<boolean> {
  const { status, json } = await perpsGet("/v1/info/registered", { address });
  const body = expectOk<RegisteredResponse>(status, json, "GET /v1/info/registered");
  return body.registered;
}

export async function fetchPublicPortfolio(address: string): Promise<PublicPortfolio> {
  const { status, json } = await perpsGet("/v1/info/portfolio", { address });
  return expectOk<PublicPortfolio>(status, json, "GET /v1/info/portfolio");
}

export async function fetchTickers(): Promise<Ticker[]> {
  const { status, json } = await perpsGet("/v1/info/tickers");
  return expectOk<Ticker[]>(status, json, "GET /v1/info/tickers");
}

export async function fetchPublicFillsPage(
  address: string,
  opts: { cursor?: string; sort?: "desc" | "asc" } = {},
): Promise<AccountTrades> {
  const query: Record<string, string> = { address, sort: opts.sort ?? "desc" };
  if (opts.cursor !== undefined) query.cursor = opts.cursor;
  const { status, json } = await perpsGet("/v1/info/fills", query);
  const page = expectOk<AccountTrades>(status, json, "GET /v1/info/fills");
  page.data = page.data.map(normalizeTrade);
  return page;
}

export async function fetchPublicFills(
  address: string,
  maxPages: number,
): Promise<{ fills: AccountTrade[]; truncated: boolean }> {
  const fills: AccountTrade[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const result = await fetchPublicFillsPage(address, cursor !== undefined ? { cursor, sort: "desc" } : { sort: "desc" });
    fills.push(...result.data);
    if (!result.more) return { fills, truncated: false };
    if (result.cursor === undefined || result.cursor === "") {
      return { fills, truncated: true };
    }
    cursor = result.cursor;
  }
  return { fills, truncated: true };
}

export async function fetchPositionSnapshots(
  address: string,
  instrumentIds: number[],
): Promise<PositionSnapshots> {
  const active: PositionSnapshotResultBatches = [];
  let historyAsOfAt = 0;
  for (let i = 0; i < instrumentIds.length; i += 20) {
    const batch = instrumentIds.slice(i, i + 20);
    const { status, json } = await perpsPost("/v1/info/position-snapshots", {
      address,
      active_instrument_ids: batch,
    });
    const page = expectOk<PositionSnapshots>(status, json, "POST /v1/info/position-snapshots");
    historyAsOfAt = page.history_as_of_at;
    active.push(...page.active);
  }
  return { history_as_of_at: historyAsOfAt, active, history: [] };
}

type PositionSnapshotResultBatches = PositionSnapshots["active"];

export async function fetchLeaderboardAccount(address: string): Promise<LeaderboardAccount | null> {
  const { status, json } = await perpsGet("/v1/info/leaderboard", {
    window: "all",
    sort_by: "pnl",
    limit: "1",
    address,
  });
  const body = expectOk<Leaderboard>(status, json, "GET /v1/info/leaderboard");
  return body.account ?? null;
}

function normalizeTrade(trade: AccountTrade): AccountTrade {
  return {
    ...trade,
    trade_id: String(trade.trade_id),
    order_id: String(trade.order_id),
  };
}

export { isApiErrorBody };
