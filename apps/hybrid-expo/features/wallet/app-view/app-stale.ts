/**
 * App view — "held value, refreshing" helpers (issue #864).
 *
 * A refresh that fails after a good load holds the last figures (the trust
 * rule of #767/#863: a failed refresh never blanks a value already shown).
 * When the app's slot has a value the top block keeps the figures dimmed and
 * shows the "Updating {app}" banner with the age of the held summary instead
 * of the #865 failure banner; with nothing held, or no value, the #865
 * failure state shows.
 *
 * Plain module: no React, no fetch, no timers — unit-tested with tsx --test
 * (app-stale.test.ts).
 */

import type { WalletSummary } from '@myboon/shared/wallet-summary';

/** The app-view apps a top block exists for (Polymarket has none yet, #714). */
export type AppViewApp = 'phoenix' | 'pacifica' | 'meteora';

/**
 * The age of a held summary, for the banner's "{age}" slot: whole minutes
 * since `fetchedAt`, never below 0. 0 → "less than a minute ago", 1 →
 * "1 minute ago", 2–59 → "{n} minutes ago", 60 or more → whole hours;
 * an unparsable date reads "a while ago".
 */
export function staleAgeText(fetchedAt: string, nowMs: number): string {
  const at = Date.parse(fetchedAt);
  if (Number.isNaN(at)) return 'a while ago';
  const minutes = Math.max(0, Math.floor((nowMs - at) / 60_000));
  if (minutes === 0) return 'less than a minute ago';
  if (minutes < 60) return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
}

/**
 * The app view's stale state (#864): a summary is held, the hook's `error`
 * is set, and this app's slot has a value (`valueUsd` not null). With no
 * summary held, or no value in the slot, the #865 failure state shows
 * instead of the stale banner.
 */
export function appIsStale(
  summary: WalletSummary | null,
  error: string | null,
  app: AppViewApp,
): boolean {
  if (summary === null || error === null) return false;
  const slot = summary.apps[app] ?? null;
  return slot !== null && slot.valueUsd !== null;
}
