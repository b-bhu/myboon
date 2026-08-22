/**
 * Per-protocol fetch adapters for Home's Wallet section.
 *
 * Each function resolves to a `WalletFetchResult` — the USD value for that
 * protocol's account row, plus the protocol-specific row content (token
 * chips, LP position pills, perps position pills) needed to render the row
 * without a second fetch. Every adapter is independent: it does its own
 * fetch against the already-existing client for that protocol and either
 * resolves or throws, so `useProtocolAccounts` can isolate failures per
 * source (PRD "fetch orchestration").
 */
import { SpotDataApiClient } from '@myboon/shared/spot';
import { meteoraClient } from '@/features/meteora/meteora.client';
import { fetchPhoenixTraderState } from '@/features/perps/phoenix.api';
import { fetchPerpsAccount, fetchPerpsPositions } from '@/features/perps/perps.public-api';
import type {
  MeteoraRowDetail,
  PerpsRowDetail,
  PerpsRowPill,
  SpotChipToken,
  SpotRowDetail,
} from '@/features/wallet/wallet.types';

const spotClient = new SpotDataApiClient();

export function invalidateSpotWalletSourceCache(): void {
  spotClient.clearCache();
}

/** Number of Spot chips shown before the row switches to a "+N" overflow chip (PRD decision #17, TC-ROWS-003). */
const SPOT_TOP_TOKEN_COUNT = 3;

export interface WalletFetchResult {
  valueUsd: number;
  detail: SpotRowDetail | MeteoraRowDetail | PerpsRowDetail | null;
}

export async function fetchSpotValueUsd(walletAddress: string): Promise<WalletFetchResult> {
  const result = await spotClient.getWalletBalances(walletAddress);
  const total = result.data.totalValueUsd;
  if (total === null) {
    throw new Error('Spot value unavailable');
  }
  return { valueUsd: total, detail: buildSpotRowDetail(result.data.tokens) };
}

/**
 * Ranks held tokens by pure USD value (largest first, no special-casing for
 * SOL — TC-ROWS-003) and splits them into the chips shown on the row plus an
 * overflow count for the "+N" chip.
 */
function buildSpotRowDetail(tokens: {
  mint: string
  symbol: string | null
  iconUrl: string | null
  valueUsd: number | null
}[]): SpotRowDetail {
  const ranked = tokens
    .filter((token) => token.valueUsd !== null && token.valueUsd > 0)
    .sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0));

  const topTokens: SpotChipToken[] = ranked.slice(0, SPOT_TOP_TOKEN_COUNT).map((token) => ({
    mint: token.mint,
    symbol: token.symbol,
    logoUri: token.iconUrl,
    valueUsd: token.valueUsd ?? 0,
  }));

  return {
    topTokens,
    overflowCount: Math.max(0, ranked.length - topTokens.length),
  };
}

export async function fetchMeteoraValueUsd(walletAddress: string): Promise<WalletFetchResult> {
  const result = await meteoraClient.getOpenPortfolio(walletAddress);

  // A wallet with zero open pools is a legitimate, successfully-fetched $0 —
  // not a failure (TC-ROWS-006). The Data API responds `total*` fields as
  // absent/null in this case, which is indistinguishable from a genuine
  // parsing problem unless we check `pools.length` first.
  if (result.data.pools.length === 0) {
    return { valueUsd: 0, detail: buildMeteoraRowDetail(result.data) };
  }

  const total = result.data.totalBalanceUsd;
  if (total === null) {
    throw new Error('Meteora value unavailable');
  }
  const parsed = Number.parseFloat(total);
  if (!Number.isFinite(parsed)) {
    throw new Error('Meteora value unavailable');
  }
  return { valueUsd: parsed, detail: buildMeteoraRowDetail(result.data) };
}

/**
 * One pill per open LP position (pool group), ring-colored by that pool's
 * own range status (TC-ROWS-004) — never a spelled-out count. Unclaimed
 * fees are summed across pools for the row's signal line.
 */
function buildMeteoraRowDetail(portfolio: {
  pools: {
    poolAddress: string
    pair: string
    outOfRange: boolean | null
    unclaimedFeesUsd: string
  }[]
  totalUnclaimedFeesUsd: string | null
}): MeteoraRowDetail {
  const pills = portfolio.pools.map((pool) => ({
    poolAddress: pool.poolAddress,
    pair: pool.pair,
    inRange: pool.outOfRange === null ? null : !pool.outOfRange,
  }));

  const feesParsed = portfolio.totalUnclaimedFeesUsd === null
    ? null
    : Number.parseFloat(portfolio.totalUnclaimedFeesUsd);

  return {
    pills,
    unclaimedFeesUsd: feesParsed !== null && Number.isFinite(feesParsed) ? feesParsed : null,
  };
}

export async function fetchPhoenixValueUsd(walletAddress: string): Promise<WalletFetchResult> {
  const state = await fetchPhoenixTraderState(walletAddress);
  const total = sumPhoenixPortfolioValue(state.traders);
  if (total === null) {
    throw new Error('Phoenix value unavailable');
  }
  return { valueUsd: total, detail: { pills: buildPhoenixRowPills(state.traders) } };
}

export async function fetchPacificaValueUsd(walletAddress: string): Promise<WalletFetchResult> {
  const [account, positions] = await Promise.all([
    fetchPerpsAccount(walletAddress),
    fetchPerpsPositions(walletAddress),
  ]);
  const pills: PerpsRowPill[] = positions.map((position) => ({
    symbol: position.symbol,
    side: position.side,
    unrealizedPnl: position.unrealizedPnl,
  }));
  return { valueUsd: account.equity, detail: { pills } };
}

/**
 * Phoenix equity (collateral + unrealized PnL) is reported per-trader-PDA as
 * `portfolioValue` on each record in `traders`. Mirrors the same field name
 * and USD-lots convention PhoenixProfileScreen's own (unexported) summary
 * uses, summed across every trader record for this authority.
 *
 * A wallet with zero trader-PDA records (never traded on Phoenix) is a
 * legitimate $0, not a failure — mirrors the same `records.length > 0` check
 * PhoenixProfileScreen's own `worstRiskLabel` uses for the same reason.
 * `null` is reserved for the genuinely ambiguous case: trader records exist
 * but none of them had a parseable `portfolioValue`, which PhoenixProfileScreen
 * itself has never had to disambiguate (it only renders once an account is
 * known to exist), but Wallet's row must, since it represents any connected
 * wallet including ones that have never touched Phoenix at all.
 */
function sumPhoenixPortfolioValue(traders: unknown[]): number | null {
  if (traders.length === 0) return 0;
  const values = traders
    .map((trader) => toUsd(asRecord(trader)?.portfolioValue))
    .filter((value): value is number => value !== null);
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0);
}

/**
 * One pill per open Phoenix position, mirroring PhoenixProfileScreen's own
 * `normalizePositions`: each trader record's `positions[]` array holds raw
 * records keyed by `symbol` / `positionSize` (sign gives side) /
 * `unrealizedPnl`. A position with zero size is not open and is skipped, the
 * same convention PhoenixProfileScreen's own normalizer uses.
 */
function buildPhoenixRowPills(traders: unknown[]): PerpsRowPill[] {
  const pills: PerpsRowPill[] = [];

  traders.forEach((trader) => {
    const traderRecord = asRecord(trader);
    if (!traderRecord) return;
    const rawPositions = Array.isArray(traderRecord.positions) ? traderRecord.positions : [];

    rawPositions.forEach((item) => {
      const record = asRecord(item);
      if (!record) return;

      const symbol = typeof record.symbol === 'string' ? record.symbol : null;
      const size = toNumber(record.positionSize) ?? 0;
      if (!symbol || size === 0) return;

      pills.push({
        symbol,
        side: size >= 0 ? 'long' : 'short',
        unrealizedPnl: toUsd(record.unrealizedPnl) ?? 0,
      });
    });
  });

  return pills;
}

function asRecord(input: unknown): Record<string, unknown> | null {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : null;
}

function toNumber(input: unknown): number | null {
  if (typeof input === 'number') return Number.isFinite(input) ? input : null;
  const record = asRecord(input);
  if (record) {
    const ui = toNumber(record.ui);
    if (ui !== null) return ui;

    const rawValue = toNumber(record.value);
    const decimals = toNumber(record.decimals);
    if (rawValue !== null && decimals !== null) {
      const scaled = rawValue / (10 ** decimals);
      return Number.isFinite(scaled) ? scaled : null;
    }
  }
  if (typeof input !== 'string' || input.trim() === '') return null;
  const parsed = Number.parseFloat(input);
  return Number.isFinite(parsed) ? parsed : null;
}

function toUsd(input: unknown): number | null {
  const value = toNumber(input);
  if (value === null) return null;
  if (
    ((typeof input === 'string' && !input.includes('.')) || typeof input === 'number')
    && Math.abs(value) >= 1_000_000
  ) {
    return value / 1_000_000;
  }
  return value;
}
