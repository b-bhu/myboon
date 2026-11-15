/**
 * Cross-venue total aggregation for the combined portfolio (issue #653).
 *
 * Extracted from `useProtocolAccounts` so the rule that decides what counts
 * toward the total is testable without React. The hook calls this; it is the
 * only place the total is computed.
 *
 * PURE — no react or react-native imports.
 */

import {
  WALLET_PROTOCOL_IDS,
  type WalletProtocolId,
  type WalletSourcesState,
  type WalletTotals,
} from '@/features/wallet/wallet.types';

/**
 * A source counts toward the total whenever it holds a real, previously
 * fetched value — resolved, stale, or mid-retry while a prior value is still
 * retained — so a retry in flight never makes the total dip (TC-STATE-003,
 * TC-STATE-005). A source that has never resolved contributes nothing.
 */
function hasValue(sources: WalletSourcesState, id: WalletProtocolId): boolean {
  return sources[id].valueUsd !== null && sources[id].resolvedAt !== null;
}

/**
 * True when at least one venue is still working or has failed outright while
 * others have values — the total on screen is then a lower bound and must say
 * so rather than silently undercounting (#653 acceptance: "indicates the total
 * is partial rather than silently undercounting").
 *
 * A venue sitting `idle` is not counted as partial: idle means nothing was
 * ever requested of it, which is the normal state for a venue the user has not
 * connected (Polymarket without an authenticated client).
 */
export function isTotalPartial(sources: WalletSourcesState): boolean {
  const anyResolved = WALLET_PROTOCOL_IDS.some((id) => hasValue(sources, id));
  if (!anyResolved) return false;
  return WALLET_PROTOCOL_IDS.some((id) => {
    const status = sources[id].status;
    if (status === 'loading') return !hasValue(sources, id);
    return status === 'failed' || status === 'stale';
  });
}

export function computeWalletTotals(sources: WalletSourcesState): WalletTotals {
  const resolved = WALLET_PROTOCOL_IDS.filter((id) => hasValue(sources, id));
  if (resolved.length === 0) {
    return { totalUsd: null, mix: {}, lastResolvedAt: null };
  }

  const totalUsd = resolved.reduce((sum, id) => sum + (sources[id].valueUsd ?? 0), 0);

  const mix: Partial<Record<WalletProtocolId, number>> = {};
  resolved.forEach((id) => {
    mix[id] = totalUsd > 0 ? (sources[id].valueUsd ?? 0) / totalUsd : 0;
  });

  const lastResolvedAt = resolved.reduce<number | null>((latest, id) => {
    const at = sources[id].resolvedAt;
    if (at === null) return latest;
    return latest === null ? at : Math.max(latest, at);
  }, null);

  return { totalUsd, mix, lastResolvedAt };
}
