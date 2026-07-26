/**
 * dormantBalance — the funded-dormant-chain safety net.
 *
 * Deferred provisioning means a dormant chain has no wallet, therefore no
 * address, therefore no balance. This module checks anyway.
 *
 * If it ever fires, deferred creation has failed somewhere: a Privy config
 * regression (`createOnLogin` flipped back on), an SDK behavior change, or a bug
 * in the activation path left an eagerly provisioned chain holding funds the
 * Wallet surface does not show. Concealing a funded address is a correctness
 * failure; displaying an empty one the user did not ask for is only a UX cost.
 * That asymmetry is why the check stays even though it should be unreachable
 * (spec, "Dormancy").
 *
 * Kept React-free and side-effect-free so the branch table can be unit tested
 * without a renderer or a live wallet, matching `chain.resolution.ts`.
 *
 * Provisioning is *observed*, never triggered: callers pass what
 * `usePrivyEvmWallet().isProvisioned` and `useWallet().connected` already
 * report. Nothing in this module calls `create()`, and nothing it returns may
 * cause a chain to be provisioned.
 *
 * Model: docs/modules/wallet/specs/wallet_connectivity.md ("Dormancy")
 */

import { CHAINS, type Chain } from '@/features/chain/chain.contract';
import type { ActivationState } from '@/features/chain/activation';

/**
 * What we observe about one chain, without provisioning it.
 *
 * `balanceUsd` is deliberately `number | null` and never defaulted to zero. Null
 * means "no balance source resolved for this chain", which is not the same as
 * "this chain holds nothing" — see `ChainRow`'s identical contract. Today EVM is
 * always null because there is no client-side EVM balance source in this app
 * (tracked in #261); fabricating a zero there would silently assert the funded
 * case cannot happen, which is exactly what this check exists to disprove.
 */
export interface DormantChainObservation {
  chain: Chain;
  /** Key material exists for this chain right now. Observed, not requested. */
  isProvisioned: boolean;
  /** The user has expressed intent for this chain (persisted activation). */
  isActive: boolean;
  /** Address if one exists. A properly dormant chain has none. */
  address: string | null;
  /** Resolved USD balance, or null when no balance source resolved. */
  balanceUsd: number | null;
}

/** A dormant chain that nonetheless holds funds. Should never exist. */
export interface FundedDormantChain {
  chain: Chain;
  address: string;
  balanceUsd: number;
}

/**
 * Chains that are provisioned but dormant *and* hold a measured non-zero
 * balance.
 *
 * Every condition must hold on evidence we actually have:
 *  - not active (an active chain renders in the normal `ChainRow`)
 *  - provisioned with a real address (nothing to conceal without one)
 *  - a balance that resolved to a non-zero number (null is unknown, not zero)
 *
 * A dormant chain with an unresolved balance is not reported. We cannot claim
 * funds we did not measure, and prompting on an unknown would fire on every
 * EVM-dormant user until #261 lands.
 */
export function findFundedDormantChains(
  observations: readonly DormantChainObservation[],
): readonly FundedDormantChain[] {
  const funded: FundedDormantChain[] = [];

  for (const observation of observations) {
    if (observation.isActive) continue;
    if (!observation.isProvisioned) continue;
    if (!observation.address) continue;

    const balance = observation.balanceUsd;
    // `null` is unknown, not zero. Only a measured, finite, positive figure
    // counts as funds being concealed.
    if (balance === null || !Number.isFinite(balance) || balance <= 0) continue;

    funded.push({
      chain: observation.chain,
      address: observation.address,
      balanceUsd: balance,
    });
  }

  return funded;
}

/**
 * Build one observation per chain from what the Wallet surface already knows.
 *
 * Takes plain values rather than hooks so it stays testable. The caller passes
 * hook output it has already read for its own rendering — this adds no wallet
 * calls and no provisioning.
 */
export function observeChains(params: {
  activation: ActivationState;
  provisioned: Record<Chain, boolean>;
  addresses: Record<Chain, string | null>;
  balancesUsd: Record<Chain, number | null>;
}): readonly DormantChainObservation[] {
  return CHAINS.map((chain) => ({
    chain,
    isProvisioned: params.provisioned[chain],
    isActive: params.activation[chain],
    address: params.addresses[chain],
    balanceUsd: params.balancesUsd[chain],
  }));
}

/**
 * Redact an address for logging. Public addresses are loggable under the
 * governing rules, but a log line does not need the whole thing to identify a
 * regression, and the shorter form is what the rest of the app displays.
 */
function redactAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * Report a fired check as the provisioning bug it is.
 *
 * This is not a user-facing warning and not an expected path. It exists so a
 * deferred-creation regression is visible in logs rather than silently absorbed
 * by a UI that quietly starts showing an extra row.
 *
 * Uses `console.warn` with a bracketed module tag, matching the convention
 * already used across the app (`features/predict/redeemErrors.ts`,
 * `features/perps/phoenix.execution.ts`). No key material is logged — only the
 * public address, truncated.
 */
export function reportFundedDormantChains(
  funded: readonly FundedDormantChain[],
): void {
  for (const entry of funded) {
    console.warn(
      '[wallet][dormancy] PROVISIONING BUG: dormant chain holds a balance.',
      {
        chain: entry.chain,
        address: redactAddress(entry.address),
        balanceUsd: entry.balanceUsd,
        expected:
          'Deferred creation means a dormant chain has no wallet and no address. '
          + 'A funded dormant chain means create() fired without user intent — '
          + 'check createOnLogin in providers/PrivyProvider.tsx and the activation path.',
      },
    );
  }
}
