/**
 * WalletSummary → one source state per app (issue #767).
 *
 * The server answers a single `GET /wallet/summary` (issue #725) whose every
 * app slot is `ok`, `unavailable` or `not_connected`. The Portfolio needs one
 * state per app out of that: ok, unavailable, not connected — or stale, which
 * the server never reports because it is phone-side knowledge: the app failed
 * on a refresh *after* it had already shown a value.
 *
 * Trust rule (docs/design/wallet.html at commit 37e0a51, "Stale row"
 * / "Stale value held, retrying"): a failed refresh never blanks a value the
 * person is already looking at. The last good value stays, dimmed, marked
 * stale, and that app gets its own retry.
 *
 * `not_connected` is neither an error nor a failure: this person has no
 * account at that venue (for example no `evm` address was sent), so it maps
 * to itself and carries no value — the design simply has no row for it.
 *
 * Plain module: no React, no fetch, no timers.
 */

import type { AppSummary, WalletSummary } from '@myboon/shared/wallet-summary';

/** One app slot inside a `WalletSummary`. */
export type WalletAppKey = keyof WalletSummary['apps'];

/**
 * Per-app state in the Portfolio. `stale` means this app had resolved before
 * and the latest refresh failed for it: the last good value is kept with its
 * own retry. `unavailable` means the app has no value yet and could not be
 * fetched. `not_connected` means the person has no account there.
 */
export type WalletAppSourceStatus = 'ok' | 'stale' | 'unavailable' | 'not_connected';

export interface WalletAppSourceState<S> {
  status: WalletAppSourceStatus;
  /** App total; the last good one while `stale`; null when nothing is known. */
  valueUsd: number | null;
  /** App summary of the last good load while `ok`/`stale`; null otherwise. */
  summary: S | null;
  /** Server `fetchedAt` of the value shown; null when there is none. */
  asOf: string | null;
  /** Human-readable reason while `unavailable`, and kept while `stale` so the
   *  row can say why its held value is stale (#769); null otherwise. */
  error: string | null;
}

/** One state per app, keyed exactly like `WalletSummary.apps`. */
export type WalletAppSourceStates = {
  [K in WalletAppKey]: WalletAppSourceState<WalletSummary['apps'][K]['summary']>;
};

/**
 * Map one app slot. `fetchedAt` is the summary's server time and becomes the
 * value's `asOf`; `previous` is this app's state from the previous mapping, so
 * a later `unavailable` can keep what a previous load had delivered instead of
 * blanking it.
 */
export function mapWalletAppSource<S>(
  app: AppSummary<S>,
  fetchedAt: string,
  previous: WalletAppSourceState<S> | null,
): WalletAppSourceState<S> {
  if (app.status === 'ok') {
    return { status: 'ok', valueUsd: app.valueUsd, summary: app.summary, asOf: fetchedAt, error: null };
  }
  if (app.status === 'not_connected') {
    // The person has no account at that venue — never carry an old value
    // forward, or a disconnected app would still render a row.
    return { status: 'not_connected', valueUsd: null, summary: null, asOf: null, error: null };
  }
  // Unavailable: keep the last good value only if one has ever been shown.
  const keep = previous !== null
    && (previous.status === 'ok' || previous.status === 'stale')
    && (previous.valueUsd !== null || previous.summary !== null);
  if (keep) {
    return {
      status: 'stale',
      valueUsd: previous.valueUsd,
      summary: previous.summary,
      asOf: previous.asOf,
      // #769: the venue's own reason stays on a stale row so it can say why
      // its last good value is stale instead of pretending all is well.
      error: app.error ?? null,
    };
  }
  return { status: 'unavailable', valueUsd: null, summary: null, asOf: null, error: app.error ?? null };
}

/**
 * Map every app of a `WalletSummary`. `previous` is null before the first
 * response; pass the previous mapping's result so failed refreshes turn into
 * stale states that hold the earlier value.
 */
export function mapWalletSummaryApps(
  summary: WalletSummary,
  previous: WalletAppSourceStates | null = null,
): WalletAppSourceStates {
  return {
    polymarket: mapWalletAppSource(summary.apps.polymarket, summary.fetchedAt, previous?.polymarket ?? null),
    phoenix: mapWalletAppSource(summary.apps.phoenix, summary.fetchedAt, previous?.phoenix ?? null),
    pacifica: mapWalletAppSource(summary.apps.pacifica, summary.fetchedAt, previous?.pacifica ?? null),
    meteora: mapWalletAppSource(summary.apps.meteora, summary.fetchedAt, previous?.meteora ?? null),
    spot: mapWalletAppSource(summary.apps.spot, summary.fetchedAt, previous?.spot ?? null),
  };
}

/**
 * Whether the Portfolio's sample balances show for this hook state (#780).
 * Sample data is a "not deployed yet" placeholder only: it stands in exactly
 * when the server answered HTTP 404 for `GET /wallet/summary` and no real
 * summary is held. Every other failure — offline, timeout, 429, 5xx, a bad
 * payload — and any held real summary shows no sample numbers: unknown is
 * unknown, never a number.
 */
export function shouldShowDemo(
  summary: WalletSummary | null,
  loading: boolean,
  errorStatus: number | null,
): boolean {
  return summary === null && loading === false && errorStatus === 404;
}
