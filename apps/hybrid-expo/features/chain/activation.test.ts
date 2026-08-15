/**
 * Tests for persisted per-chain activation.
 *
 * Activation stickiness is what makes the resolver's branch 1 reachable across a
 * restart. The spec is explicit that a session "survives backgrounding, process
 * death, and app restart", and that "anything less makes stickiness
 * meaningless" — so process death is simulated here for real, by dropping the
 * module cache and re-hydrating from the same backing store.
 *
 * Covers: TC-SESSION-001, TC-SESSION-002, TC-SESSION-005, TC-SESSION-006 (the
 * persistence half), TC-SESSION-007 (the clear-on-logout half).
 *
 * Run: pnpm --filter hybrid-expo test:activation
 *
 * AsyncStorage is a native module and cannot load under `tsx`, so it is replaced
 * in `require.cache` before `activation.ts` is imported. The stub is a real
 * key/value store, not a spy: a test that asserted only on calls would pass even
 * if nothing were ever read back, which is the exact failure these cases exist
 * to catch.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Backing store, deliberately *outside* the module cache. Clearing the module
 * cache models process death; this map models the disk that survives it.
 */
const disk = new Map<string, string>();

let failNextRead = false;
let failNextWrite = false;

const asyncStorageId = require.resolve('@react-native-async-storage/async-storage');
require.cache[asyncStorageId] = {
  id: asyncStorageId,
  filename: asyncStorageId,
  loaded: true,
  exports: {
    __esModule: true,
    default: {
      getItem: async (key: string) => {
        if (failNextRead) {
          failNextRead = false;
          throw new Error('simulated storage read failure');
        }
        return disk.get(key) ?? null;
      },
      setItem: async (key: string, value: string) => {
        if (failNextWrite) {
          failNextWrite = false;
          throw new Error('simulated storage write failure');
        }
        disk.set(key, value);
      },
      removeItem: async (key: string) => {
        disk.delete(key);
      },
    },
  },
} as never;

type ActivationModule = typeof import('@/features/chain/activation');

const ACTIVATION_MODULE_PATH = require.resolve('@/features/chain/activation');

/**
 * Load activation fresh, as a newly started process would.
 *
 * `require()` rather than `import()` on purpose: under tsx these files are CJS,
 * and a dynamic `import()` returns a cached ESM namespace object that survives
 * `delete require.cache[...]`. That would silently reuse the module's in-memory
 * activation cache and make every "survives a restart" assertion vacuous — the
 * value would come from memory, not from storage. `require()` after the cache
 * delete gives a genuinely fresh module.
 */
function loadActivation(): ActivationModule {
  delete require.cache[ACTIVATION_MODULE_PATH];
  return require(ACTIVATION_MODULE_PATH) as ActivationModule;
}

/**
 * Simulate process death: the module and its in-memory cache go away, the
 * backing store does not. Anything that survives this came from storage.
 */
function restartApp(): ActivationModule {
  return loadActivation();
}

beforeEach(() => {
  disk.clear();
  failNextRead = false;
  failNextWrite = false;
});

describe('activation — a fresh install', () => {
  it('starts with no chain active', async () => {
    const activation = loadActivation();
    const state = await activation.hydrateActivation();
    assert.deepEqual(state, { solana: false, evm: false });
    assert.deepEqual(activation.activeChains(state), []);
  });

  it('reports nothing active before hydration rather than guessing', async () => {
    const activation = loadActivation();
    // Pre-hydration the snapshot must not claim intent the user has not
    // expressed; the resolver reports `preparing` off the hydrated flag.
    assert.equal(activation.isActivationHydrated(), false);
    assert.deepEqual(activation.getActivationSnapshot(), { solana: false, evm: false });
  });
});

describe('activation — stickiness (TC-SESSION-001, TC-SESSION-002)', () => {
  it('activating a chain makes it active for every application on that chain', async () => {
    const activation = loadActivation();
    await activation.activateChain('solana');

    // A second application on the same chain reads the same record: activation
    // is keyed by chain, so there is nothing per-application to diverge.
    assert.equal(await activation.isChainActive('solana'), true);
    assert.deepEqual(activation.activeChains(activation.getActivationSnapshot()), ['solana']);
  });

  it('activation does not leak across chains', async () => {
    const activation = loadActivation();
    await activation.activateChain('evm');

    assert.equal(await activation.isChainActive('evm'), true);
    assert.equal(
      await activation.isChainActive('solana'),
      false,
      'activating EVM must not activate Solana',
    );
    assert.deepEqual(activation.activeChains(activation.getActivationSnapshot()), ['evm']);
  });

  it('is idempotent — activating twice changes nothing and writes no second record', async () => {
    const activation = loadActivation();
    await activation.activateChain('solana');
    const afterFirst = disk.get('chain_activation_v1');

    await activation.activateChain('solana');
    assert.equal(disk.get('chain_activation_v1'), afterFirst);
    assert.deepEqual(activation.activeChains(activation.getActivationSnapshot()), ['solana']);
  });

  it('holds both chains active independently', async () => {
    const activation = loadActivation();
    await activation.activateChain('solana');
    await activation.activateChain('evm');
    assert.deepEqual(
      [...activation.activeChains(activation.getActivationSnapshot())].sort(),
      ['evm', 'solana'],
    );
  });
});

describe('activation — survives process death (TC-SESSION-006)', () => {
  it('an activated chain is still active after a restart', async () => {
    const first = loadActivation();
    await first.activateChain('evm');

    const afterRestart = restartApp();
    // Fresh module: nothing in memory yet, everything must come from storage.
    assert.equal(afterRestart.isActivationHydrated(), false);

    const state = await afterRestart.hydrateActivation();
    assert.equal(state.evm, true, 'EVM activation must survive process death');
    assert.equal(state.solana, false, 'a chain never activated stays dormant across restart');
  });

  it('a chain that was dormant before the restart is still dormant after it', async () => {
    const first = loadActivation();
    await first.activateChain('evm');

    const afterRestart = restartApp();
    const state = await afterRestart.hydrateActivation();
    assert.deepEqual(activeSorted(afterRestart, state), ['evm']);
  });

  it('both chains survive a restart when both were activated', async () => {
    const first = loadActivation();
    await first.activateChain('solana');
    await first.activateChain('evm');

    const afterRestart = restartApp();
    const state = await afterRestart.hydrateActivation();
    assert.deepEqual(activeSorted(afterRestart, state), ['evm', 'solana']);
  });

  it('survives repeated restarts, not just the first', async () => {
    const first = loadActivation();
    await first.activateChain('solana');

    const second = restartApp();
    assert.equal((await second.hydrateActivation()).solana, true);

    const third = restartApp();
    assert.equal((await third.hydrateActivation()).solana, true);
  });
});

describe('activation — the session boundary (TC-SESSION-007)', () => {
  it('logout clears every chain, in memory and on disk', async () => {
    const activation = loadActivation();
    await activation.activateChain('solana');
    await activation.activateChain('evm');

    await activation.clearActivation();
    assert.deepEqual(activation.getActivationSnapshot(), { solana: false, evm: false });

    // The clear must be durable: a restart after logout must not resurrect the
    // pre-logout active set.
    const afterRestart = restartApp();
    assert.deepEqual(await afterRestart.hydrateActivation(), { solana: false, evm: false });
  });

  it('disconnecting one chain leaves the other untouched (TC-WALLET-006)', async () => {
    const activation = loadActivation();
    await activation.activateChain('solana');
    await activation.activateChain('evm');

    await activation.deactivateChain('solana');

    const state = activation.getActivationSnapshot();
    assert.equal(state.solana, false, 'disconnected chain leaves the active set');
    assert.equal(state.evm, true, 'the other chain is untouched');
  });

  it('deactivating a chain that was never active is a no-op', async () => {
    const activation = loadActivation();
    await activation.activateChain('evm');
    const before = disk.get('chain_activation_v1');

    await activation.deactivateChain('solana');
    assert.equal(disk.get('chain_activation_v1'), before);
  });

  it('a chain can be re-activated after being disconnected', async () => {
    const activation = loadActivation();
    await activation.activateChain('solana');
    await activation.deactivateChain('solana');
    await activation.activateChain('solana');
    assert.equal(await activation.isChainActive('solana'), true);
  });
});

describe('activation — connection reconciliation edges', () => {
  it('does not resurrect activation from the stale external account render after disconnect', () => {
    const activation = loadActivation();
    assert.equal(activation.shouldReconcileConnectedChain({
      isHydrated: true,
      isConnected: true,
      wasConnected: true,
      isActive: false,
    }), false);
  });

  it('does activate a genuinely new or restored live connection', () => {
    const activation = loadActivation();
    assert.equal(activation.shouldReconcileConnectedChain({
      isHydrated: true,
      isConnected: true,
      wasConnected: false,
      isActive: false,
    }), true);
  });
});

describe('activation — corrupt and hostile stored state', () => {
  it('treats unparseable JSON as nothing active rather than throwing', async () => {
    disk.set('chain_activation_v1', '{not valid json');
    const activation = loadActivation();
    assert.deepEqual(await activation.hydrateActivation(), { solana: false, evm: false });
  });

  it('ignores junk field types instead of coercing them to active', async () => {
    // Only a literal `true` counts. A truthy string must not activate a chain —
    // that would surface an account on the strength of corrupt storage.
    disk.set('chain_activation_v1', JSON.stringify({ solana: 'yes', evm: 1 }));
    const activation = loadActivation();
    assert.deepEqual(await activation.hydrateActivation(), { solana: false, evm: false });
  });

  it('ignores unknown chains in stored state', async () => {
    disk.set('chain_activation_v1', JSON.stringify({ solana: true, bitcoin: true }));
    const activation = loadActivation();
    const state = await activation.hydrateActivation();
    assert.deepEqual(state, { solana: true, evm: false });
    assert.deepEqual(activation.activeChains(state), ['solana']);
  });

  it('falls back to nothing-active when the read fails, rather than wedging', async () => {
    disk.set('chain_activation_v1', JSON.stringify({ solana: true, evm: true }));
    failNextRead = true;

    const activation = loadActivation();
    const state = await activation.hydrateActivation();
    // Failing closed prompts the user; failing open would assume intent that was
    // never expressed.
    assert.deepEqual(state, { solana: false, evm: false });
    assert.equal(activation.isActivationHydrated(), true, 'a failed read still settles');
  });

  it('a failed write still reflects intent in memory for this session', async () => {
    const activation = loadActivation();
    failNextWrite = true;

    await activation.activateChain('solana');
    // Losing the write costs a re-prompt next launch, not correctness now.
    assert.equal(activation.getActivationSnapshot().solana, true);
  });
});

describe('activation — subscribers', () => {
  it('notifies subscribers on activation', async () => {
    const activation = loadActivation();
    const seen: boolean[] = [];
    const unsubscribe = activation.subscribeToActivation((state) => seen.push(state.solana));

    await activation.activateChain('solana');
    unsubscribe();

    assert.ok(seen.includes(true), 'subscriber saw the activation');
  });

  it('stops notifying after unsubscribe', async () => {
    const activation = loadActivation();
    let calls = 0;
    const unsubscribe = activation.subscribeToActivation(() => { calls += 1; });
    unsubscribe();

    await activation.activateChain('evm');
    assert.equal(calls, 0);
  });

  it('every consumer observes the same state — one record, not one per caller', async () => {
    const activation = loadActivation();
    const seenA: boolean[] = [];
    const seenB: boolean[] = [];
    const unsubA = activation.subscribeToActivation((s) => seenA.push(s.evm));
    const unsubB = activation.subscribeToActivation((s) => seenB.push(s.evm));

    await activation.activateChain('evm');
    unsubA();
    unsubB();

    assert.deepEqual(seenA, seenB, 'both consumers see identical state');
  });
});

function activeSorted(
  activation: ActivationModule,
  state: { solana: boolean; evm: boolean },
): string[] {
  return [...activation.activeChains(state)].sort();
}
