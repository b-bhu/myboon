/**
 * chain.resolution — the four-branch resolution rule, as a pure function.
 *
 * Kept separate from `useChainSigner` so the branch table can be unit tested
 * without a renderer or a live wallet. The hook supplies the observed state;
 * this module decides what it means.
 *
 * Resolution order (docs/modules/wallet/specs/wallet_connectivity.md):
 *
 *   1. chain active                 -> ready
 *   2. chain provisioned, dormant   -> activate, then ready
 *   3. neither                      -> needs_connection
 *   4. no backend can satisfy       -> unsupported + human-readable reason
 *
 * Branch 4 is evaluated first: an unsatisfiable requirement is a static property
 * of the requirement and the backend table, independent of session state.
 */

import {
  backendsForRequirement,
  unsupportedReason,
  type ChainRequirement,
  type WalletBackend,
} from '@/features/chain/chain.contract';

export type ChainSignerStatus =
  | 'ready'
  | 'needs_connection'
  | 'preparing'
  | 'unsupported';

/** Everything the resolver observes about the current session, per backend. */
export interface ResolutionInput {
  /** The user has expressed intent for this chain (persisted). */
  isActive: boolean;
  /** Activation state has been read back from storage. */
  isActivationHydrated: boolean;
  /**
   * Backends with key material for this chain right now, in preference order.
   * A Privy user who has not yet had a wallet created is *not* provisioned.
   */
  provisionedBackends: readonly WalletBackend[];
  /** Whether the user is authenticated with Privy — able to provision on demand. */
  canProvisionOnDemand: boolean;
  /** A create()/authorize() call, or storage hydration, is in flight. */
  isBusy: boolean;
}

export interface Resolution {
  status: ChainSignerStatus;
  reason: string | null;
  /** The backend that should serve this requirement, when one is resolvable. */
  backend: WalletBackend | null;
  /**
   * True when the chain is provisioned but not yet active — branch 2. The caller
   * records activation, after which the same input resolves to `ready`.
   */
  needsActivation: boolean;
}

export function resolveChainSigner(
  requirement: ChainRequirement,
  input: ResolutionInput,
): Resolution {
  // Branch 4 — no backend can satisfy this requirement at all. Static; checked
  // before any session state so an impossible requirement never reports
  // `needs_connection` and sends the user into a modal that cannot help.
  const eligible = backendsForRequirement(requirement);
  if (eligible.length === 0) {
    return {
      status: 'unsupported',
      reason: unsupportedReason(requirement),
      backend: null,
      needsActivation: false,
    };
  }

  // Until activation is read back from storage we cannot tell branch 1 from
  // branch 3. Reporting `needs_connection` here would re-prompt a user who has
  // already activated — exactly the stickiness failure the spec forbids.
  if (!input.isActivationHydrated || input.isBusy) {
    return { status: 'preparing', reason: null, backend: null, needsActivation: false };
  }

  const provisioned = eligible.filter((backend) =>
    input.provisionedBackends.includes(backend),
  );
  const backend = provisioned[0] ?? null;

  // Branch 1 — active and provisioned.
  if (input.isActive && backend) {
    return { status: 'ready', reason: null, backend, needsActivation: false };
  }

  // Branch 2 — provisioned but dormant. Activate, then it is ready.
  if (!input.isActive && backend) {
    return { status: 'needs_connection', reason: null, backend, needsActivation: true };
  }

  // Active but nothing provisioned. A Privy user can provision on demand, so
  // this is transient work rather than a connection prompt; anyone else needs to
  // connect.
  if (input.isActive && !backend) {
    if (input.canProvisionOnDemand) {
      return { status: 'preparing', reason: null, backend: null, needsActivation: false };
    }
    return {
      status: 'needs_connection',
      reason: null,
      backend: null,
      needsActivation: false,
    };
  }

  // Branch 3 — neither active nor provisioned.
  return { status: 'needs_connection', reason: null, backend: null, needsActivation: false };
}
