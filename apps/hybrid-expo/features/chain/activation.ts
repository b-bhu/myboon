/**
 * activation — persisted per-chain activation state.
 *
 * "Active" means the user has expressed intent for this chain. Only active
 * chains are surfaced, funded, and offered to applications.
 *
 * Per the spec's Session boundary: a session ends only on explicit user action —
 * disconnecting a wallet, or logging out. It survives backgrounding, process
 * death, and app restart. Activation is therefore written to AsyncStorage rather
 * than held in React state: a user who backgrounds the app and returns must not
 * be re-prompted for a chain they already activated.
 *
 * AsyncStorage is what the rest of the app already uses for durable client state
 * (`hooks/useOddsFormat.ts`, `hooks/usePolymarketWallet.ts`), so no new
 * dependency is introduced.
 *
 * Model: docs/modules/wallet/specs/wallet_connectivity.md
 */

import { useCallback, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { CHAINS, type Chain } from '@/features/chain/chain.contract';

const STORAGE_KEY = 'chain_activation_v1';

export interface ActivationState {
  solana: boolean;
  evm: boolean;
}

export const EMPTY_ACTIVATION: ActivationState = Object.freeze({
  solana: false,
  evm: false,
});

/**
 * Module-level cache so every `useChainActivation()` instance reports the same
 * value and a change in one is seen by all. This is a cache of persisted state,
 * not a source of truth, and it holds no key material — the governing rule
 * against module-level mutable *wallet* singletons is not in play here.
 */
let cache: ActivationState = EMPTY_ACTIVATION;
let hydrated = false;
let hydrating: Promise<ActivationState> | null = null;

type Listener = (state: ActivationState) => void;
const listeners = new Set<Listener>();

function emit() {
  listeners.forEach((listener) => listener(cache));
}

/** Narrow arbitrary parsed JSON to a valid ActivationState, ignoring junk. */
function parseActivation(raw: string | null): ActivationState {
  if (!raw) return EMPTY_ACTIVATION;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return EMPTY_ACTIVATION;
    const record = parsed as Record<string, unknown>;
    return {
      solana: record.solana === true,
      evm: record.evm === true,
    };
  } catch {
    return EMPTY_ACTIVATION;
  }
}

/**
 * Read activation from storage. Safe to call repeatedly — the first call does
 * the read and later calls share its result.
 */
export function hydrateActivation(): Promise<ActivationState> {
  if (hydrated) return Promise.resolve(cache);
  if (hydrating) return hydrating;

  hydrating = AsyncStorage.getItem(STORAGE_KEY)
    .then((raw) => {
      cache = parseActivation(raw);
      hydrated = true;
      emit();
      return cache;
    })
    .catch(() => {
      // A failed read must not leave the app wedged: fall back to "nothing
      // active", which prompts rather than silently assuming intent.
      cache = EMPTY_ACTIVATION;
      hydrated = true;
      emit();
      return cache;
    })
    .finally(() => {
      hydrating = null;
    });

  return hydrating;
}

function persist(next: ActivationState): Promise<void> {
  cache = next;
  hydrated = true;
  emit();
  return AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next)).catch(() => {
    // Swallow: in-memory state already reflects the user's intent for this
    // session. Losing the write costs a re-prompt next launch, not correctness.
  });
}

/** Current activation without waiting on storage. May be stale before hydration. */
export function getActivationSnapshot(): ActivationState {
  return cache;
}

export function isActivationHydrated(): boolean {
  return hydrated;
}

export async function isChainActive(chain: Chain): Promise<boolean> {
  const state = await hydrateActivation();
  return state[chain];
}

/** Record user intent for a chain. Idempotent — activating twice is a no-op. */
export async function activateChain(chain: Chain): Promise<ActivationState> {
  const current = await hydrateActivation();
  if (current[chain]) return current;
  const next: ActivationState = { ...current, [chain]: true };
  await persist(next);
  return next;
}

/**
 * Clear activation for one chain. Explicit disconnect only — this is a session
 * boundary, not something backgrounding or a failed read may trigger.
 */
export async function deactivateChain(chain: Chain): Promise<ActivationState> {
  const current = await hydrateActivation();
  if (!current[chain]) return current;
  const next: ActivationState = { ...current, [chain]: false };
  await persist(next);
  return next;
}

/**
 * Clear activation for every chain. Called on explicit logout — the other half
 * of the session boundary.
 */
export async function clearActivation(): Promise<ActivationState> {
  await persist({ ...EMPTY_ACTIVATION });
  return cache;
}

/** Test-only: drop the module cache so a fresh hydrate re-reads storage. */
export function resetActivationCacheForTests(): void {
  cache = EMPTY_ACTIVATION;
  hydrated = false;
  hydrating = null;
  listeners.clear();
}

export function subscribeToActivation(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export interface ChainActivation {
  activation: ActivationState;
  /** False until the first storage read completes. */
  isHydrated: boolean;
  activate: (chain: Chain) => Promise<void>;
  deactivate: (chain: Chain) => Promise<void>;
  clearAll: () => Promise<void>;
}

/**
 * React binding over the persisted activation state.
 *
 * Deliberately free of wallet imports so this module stays testable without a
 * renderer — pulling `useWallet` in here drags React Native's Flow-typed entry
 * point into the unit runner. Reconciling a live connection into activation is
 * `useActivationReconciler`, mounted once at the app root.
 */
export function useChainActivation(): ChainActivation {
  const [activation, setActivation] = useState<ActivationState>(getActivationSnapshot);
  const [isHydrated, setIsHydrated] = useState<boolean>(isActivationHydrated);

  useEffect(() => {
    let cancelled = false;
    const unsubscribe = subscribeToActivation((next) => {
      if (!cancelled) setActivation(next);
    });

    hydrateActivation().then((next) => {
      if (cancelled) return;
      setActivation(next);
      setIsHydrated(true);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);


  const activate = useCallback(async (chain: Chain) => {
    await activateChain(chain);
  }, []);

  const deactivate = useCallback(async (chain: Chain) => {
    await deactivateChain(chain);
  }, []);

  const clearAll = useCallback(async () => {
    await clearActivation();
  }, []);

  return { activation, isHydrated, activate, deactivate, clearAll };
}

/** Chains the user has expressed intent for. Drives what the Wallet surface shows. */
export function activeChains(state: ActivationState): readonly Chain[] {
  return CHAINS.filter((chain) => state[chain]);
}
