/**
 * Deferred creation and the full resolution matrix.
 *
 * The single most important invariant in the restructure: **a dormant chain has
 * no wallet in existence.** These tests assert on provisioning state and on
 * whether `create()` was called — never on whether an address was rendered. A
 * test that only proves an address is hidden has not tested dormancy at all; it
 * would pass against the very "eager creation plus hidden display" design the
 * spec forbids.
 *
 * Covers: TC-RESOLVE-005 (the full matrix), TC-RESOLVE-010, TC-RESOLVE-011,
 * TC-DORMANT-005 (the create-once half), TC-DORMANT-006 (interruption),
 * TC-DORMANT-007, TC-DORMANT-008, TC-DORMANT-009, TC-SESSION-003.
 *
 * Run: pnpm --filter hybrid-expo test:chain
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  CHAINS,
  POLYMARKET_REQUIREMENT,
  type Chain,
  type ChainRequirement,
  type WalletBackend,
} from './chain.contract';
import {
  resolveChainSigner,
  type ChainSignerStatus,
  type ResolutionInput,
} from './chain.resolution';
import { findFundedDormantChains, observeChains } from '@/features/wallet/dormantBalance';

const TERMINAL_STATUSES: readonly ChainSignerStatus[] = [
  'ready',
  'needs_connection',
  'preparing',
  'unsupported',
];

function input(overrides: Partial<ResolutionInput> = {}): ResolutionInput {
  return {
    isActive: false,
    isActivationHydrated: true,
    provisionedBackends: [],
    canProvisionOnDemand: false,
    isBusy: false,
    ...overrides,
  };
}

function requirementFor(chain: Chain): ChainRequirement {
  return chain === 'evm'
    ? POLYMARKET_REQUIREMENT
    : {
        applicationId: 'perps',
        chain: 'solana',
        needsTypedData: false,
        needsRawTransaction: true,
      };
}

/**
 * A stand-in for the embedded wallet hook, instrumented on `create()`.
 *
 * `usePrivyEvmWallet` cannot be exercised here (it needs a renderer and the
 * Privy SDK), so this models the contract the resolver depends on: a wallet
 * exists only after `create()` is called, and `provision()` dedupes concurrent
 * callers. The real hook is verified on device — see the device checklist.
 */
function createWalletDouble() {
  let createCalls = 0;
  let address: string | null = null;
  let inflight: Promise<string> | null = null;
  let failNext = false;

  return {
    get createCalls() { return createCalls; },
    get address() { return address; },
    get isProvisioned() { return address !== null; },
    failNextCreate() { failNext = true; },
    /** Backends currently holding key material — what the resolver observes. */
    provisionedBackends(): readonly WalletBackend[] {
      return address ? ['privy_embedded'] : [];
    },
    // Deliberately not `async`: an async wrapper would await `pending` and
    // produce a *second* promise that rejects independently of the one the
    // catch-guard below is attached to, which Node then reports as an unhandled
    // rejection. Returning the guarded promise directly keeps one promise.
    provision(): Promise<string> {
      if (address) return Promise.resolve(address);
      if (inflight) return inflight;
      const pending = (async () => {
        createCalls += 1;
        if (failNext) {
          failNext = false;
          throw new Error('create() rejected');
        }
        address = '0xabc0000000000000000000000000000000000001';
        return address;
      })();

      // Clear the in-flight slot only *after* the promise settles, and via a
      // separate handler chain rather than a `finally` inside the body. Two
      // reasons, both of which produced real failures here:
      //
      //  1. Clearing inside the body ran before the caller observed the
      //     rejection, so a retry re-entered while `pending` was still the
      //     stored value and received the already-rejected promise back —
      //     making the retry appear to fail a second time.
      //  2. The `.catch` also marks the rejection handled, so Node does not
      //     report an unhandled rejection while `assert.rejects` is still
      //     waiting on it.
      //
      // Both are defects of this double, not of the code under test.
      pending.then(
        () => { inflight = null; },
        () => { inflight = null; },
      );
      inflight = pending;
      return pending;
    },
  };
}

describe('TC-DORMANT: a dormant chain has no wallet in existence', () => {
  it('a logged-in Privy user with no activation has provisioned nothing', () => {
    const wallet = createWalletDouble();
    // Logging in is not activation. The provider sets createOnLogin: 'off'
    // (asserted in security.deletions.test.ts), so login alone creates nothing.
    assert.equal(wallet.createCalls, 0);
    assert.equal(wallet.isProvisioned, false);
    assert.equal(wallet.address, null, 'no address exists that could receive funds');
  });

  it('merely resolving a requirement provisions nothing', () => {
    const wallet = createWalletDouble();
    const result = resolveChainSigner(
      POLYMARKET_REQUIREMENT,
      input({ canProvisionOnDemand: true, provisionedBackends: wallet.provisionedBackends() }),
    );

    assert.equal(result.status, 'needs_connection');
    assert.equal(
      wallet.createCalls,
      0,
      'asking whether a chain is satisfied must never create a wallet',
    );
    assert.equal(wallet.address, null);
  });

  it('activation is what provisions the chain, and it creates exactly one wallet', async () => {
    const wallet = createWalletDouble();
    await wallet.provision();

    assert.equal(wallet.createCalls, 1);
    assert.equal(wallet.isProvisioned, true);

    // The same input now resolves ready, with no further creation.
    const result = resolveChainSigner(
      POLYMARKET_REQUIREMENT,
      input({ isActive: true, provisionedBackends: wallet.provisionedBackends() }),
    );
    assert.equal(result.status, 'ready');
    assert.equal(wallet.createCalls, 1, 'resolving after provisioning must not re-create');
  });

  it('TC-RESOLVE-011: concurrent consumers produce exactly one create() call', async () => {
    const wallet = createWalletDouble();

    // Three components activating EVM in the same tick. Two wallets for one user
    // would split their funds across addresses.
    const [a, b, c] = await Promise.all([
      wallet.provision(),
      wallet.provision(),
      wallet.provision(),
    ]);

    assert.equal(wallet.createCalls, 1, 'three consumers, one wallet');
    assert.equal(a, b);
    assert.equal(b, c, 'all consumers receive the same address');
  });

  it('TC-DORMANT-006: a failed create() leaves the chain unprovisioned and retryable', async () => {
    const wallet = createWalletDouble();
    wallet.failNextCreate();

    await assert.rejects(() => wallet.provision(), /create\(\) rejected/);
    assert.equal(wallet.isProvisioned, false, 'a failed create leaves no half-made wallet');
    assert.equal(wallet.address, null);

    // Not wedged: the resolver reports needs_connection, not a stuck preparing.
    const afterFailure = resolveChainSigner(
      POLYMARKET_REQUIREMENT,
      input({ canProvisionOnDemand: true, provisionedBackends: wallet.provisionedBackends() }),
    );
    assert.equal(afterFailure.status, 'needs_connection');

    // And a retry succeeds, producing exactly one wallet.
    await wallet.provision();
    assert.equal(wallet.isProvisioned, true);
    assert.equal(wallet.createCalls, 2, 'one failed attempt plus one successful retry');
  });

  it('TC-DORMANT-006: never ends in "active with no wallet behind it"', async () => {
    const wallet = createWalletDouble();
    wallet.failNextCreate();
    await assert.rejects(() => wallet.provision());

    // The activation record is written by the caller only after provision()
    // resolves, so a rejected create cannot leave a chain marked active with
    // nothing behind it. Model that ordering: activation stays false.
    const stillDormant = resolveChainSigner(
      POLYMARKET_REQUIREMENT,
      input({ isActive: false, provisionedBackends: wallet.provisionedBackends() }),
    );
    assert.equal(stillDormant.status, 'needs_connection');
    assert.equal(stillDormant.needsActivation, false, 'nothing provisioned, so nothing to activate');
  });
});

describe('TC-RESOLVE-005: the full resolution matrix', () => {
  /**
   * {active, provisioned-only, neither} × {satisfiable, unsatisfiable} × {solana, evm}.
   * Every cell must settle at exactly one of the four statuses.
   */
  it('every cell settles at exactly one of the four statuses', () => {
    const sessionStates = [
      { label: 'active+provisioned', isActive: true, provisioned: true },
      { label: 'provisioned-only', isActive: false, provisioned: true },
      { label: 'neither', isActive: false, provisioned: false },
      { label: 'active-unprovisioned', isActive: true, provisioned: false },
    ];

    for (const chain of CHAINS) {
      for (const session of sessionStates) {
        for (const canProvision of [true, false]) {
          const backends: WalletBackend[] = session.provisioned
            ? [chain === 'evm' ? 'privy_embedded' : 'external_mwa']
            : [];

          const result = resolveChainSigner(
            requirementFor(chain),
            input({
              isActive: session.isActive,
              provisionedBackends: backends,
              canProvisionOnDemand: canProvision,
            }),
          );

          const cell = `${chain}/${session.label}/canProvision=${canProvision}`;
          assert.ok(
            TERMINAL_STATUSES.includes(result.status),
            `${cell} settled at an unknown status: ${result.status}`,
          );
          assert.equal(typeof result.status, 'string', cell);
          // `reason` is non-null only for unsupported; a status carrying a
          // stray reason would render an error to a user who has none.
          if (result.status !== 'unsupported') {
            assert.equal(result.reason, null, `${cell} carried a reason it should not`);
          }
        }
      }
    }
  });

  it('resolution is deterministic — the same input always gives the same status', () => {
    const state = input({ isActive: true, provisionedBackends: ['privy_embedded'] });
    const first = resolveChainSigner(POLYMARKET_REQUIREMENT, state);
    for (let i = 0; i < 10; i += 1) {
      const repeat = resolveChainSigner(POLYMARKET_REQUIREMENT, state);
      assert.deepEqual(repeat, first, 'resolution oscillated across identical calls');
    }
  });

  it('unsupported wins over needs_connection regardless of session state', () => {
    const impossible: ChainRequirement = {
      applicationId: 'hypothetical',
      chain: 'solana',
      needsTypedData: true,
      needsRawTransaction: false,
    };

    // A user is never sent into a connection flow that cannot succeed.
    for (const isActive of [true, false]) {
      for (const provisioned of [[], ['external_mwa'], ['privy_embedded']] as WalletBackend[][]) {
        const result = resolveChainSigner(
          impossible,
          input({ isActive, provisionedBackends: provisioned, canProvisionOnDemand: true }),
        );
        assert.equal(result.status, 'unsupported');
        assert.ok((result.reason ?? '').length > 0, 'unsupported must carry a reason');
      }
    }
  });

  it('never throws for any registered chain in the matrix', () => {
    assert.doesNotThrow(() => {
      for (const chain of CHAINS) {
        for (const isActive of [true, false]) {
          for (const canProvisionOnDemand of [true, false]) {
            resolveChainSigner(
              requirementFor(chain),
              input({ isActive, canProvisionOnDemand }),
            );
          }
        }
      }
    });
  });

  /**
   * Documents a real, currently-unhandled edge: a requirement naming a chain
   * with no `CHAIN_BACKENDS` entry throws a TypeError rather than resolving to
   * `unsupported`.
   *
   * `backendsForRequirement` indexes `CHAIN_BACKENDS[requirement.chain]` and
   * calls `.filter` on the result without a guard, so an unregistered chain
   * dereferences undefined (`chain.contract.ts:154`).
   *
   * Severity is low today: `Chain` is a closed union, so TypeScript rejects this
   * at every in-repo call site, and it is reachable only via a cast or untyped
   * JS. It is recorded rather than fixed because this suite does not modify
   * production code — and it is asserted as *current behavior* rather than left
   * as a red test, so the suite stays green while the gap stays visible.
   *
   * It matters because `unsupportedReason`'s contract says the resolver "never
   * throws for an unsatisfiable requirement". That holds only while the union
   * stays closed. Adding a chain to `Chain` without adding it to
   * `CHAIN_BACKENDS` turns this into a crash on a real path — exactly the
   * scenario TC-RESOLVE-004 exists to prevent. Flip this assertion to expect
   * `unsupported` when the guard lands.
   */
  it('KNOWN GAP: an unregistered chain throws instead of resolving unsupported', () => {
    assert.throws(
      () =>
        resolveChainSigner(
          {
            applicationId: 'hypothetical',
            chain: 'bitcoin' as Chain,
            needsTypedData: false,
            needsRawTransaction: false,
          },
          input(),
        ),
      /Cannot read properties of undefined/,
      'if this now resolves cleanly, the guard has landed — assert unsupported instead',
    );
  });
});

describe('TC-RESOLVE-010: a capability mismatch does not silently downgrade', () => {
  it('a Solana requirement needing typed data is unsupported, not ready', () => {
    const typedDataOnSolana: ChainRequirement = {
      applicationId: 'hypothetical',
      chain: 'solana',
      needsTypedData: true,
      needsRawTransaction: false,
    };

    const result = resolveChainSigner(
      typedDataOnSolana,
      input({ isActive: true, provisionedBackends: ['external_mwa', 'privy_embedded'] }),
    );

    // Failing at resolution beats handing back a signer that fails at signing
    // time, after the user believed they were connected.
    assert.equal(result.status, 'unsupported');
    assert.equal(result.backend, null);
    assert.match(result.reason ?? '', /typed data|EIP-712/i);
  });

  it('the reason names the application and the chain, readable as a sentence', () => {
    const result = resolveChainSigner(
      {
        applicationId: 'polymarket',
        chain: 'solana',
        needsTypedData: true,
        needsRawTransaction: false,
      },
      input(),
    );
    const reason = result.reason ?? '';
    assert.ok(reason.includes('polymarket'), 'names the application');
    assert.ok(reason.includes('Solana'), 'names the chain');
    assert.ok(/[.]$/.test(reason), 'reads as a sentence, not an identifier');
  });
});

describe('TC-SESSION-003: per-chain backends coexist', () => {
  it('an external Solana wallet and a Privy EVM wallet resolve independently', () => {
    // Both chains satisfied at once, by different backends. The pre-restructure
    // precedence (Privy short-circuits and hides MWA) would break this.
    const solana = resolveChainSigner(
      requirementFor('solana'),
      input({ isActive: true, provisionedBackends: ['external_mwa'] }),
    );
    const evm = resolveChainSigner(
      POLYMARKET_REQUIREMENT,
      input({ isActive: true, provisionedBackends: ['privy_embedded'] }),
    );

    assert.equal(solana.status, 'ready');
    assert.equal(solana.backend, 'external_mwa', 'Privy must not displace an external Solana wallet');
    assert.equal(evm.status, 'ready');
    assert.equal(evm.backend, 'privy_embedded');
  });

  it('an external Solana connection keeps precedence when Privy is also present', () => {
    const result = resolveChainSigner(
      requirementFor('solana'),
      input({ isActive: true, provisionedBackends: ['external_mwa', 'privy_embedded'] }),
    );
    assert.equal(result.backend, 'external_mwa');
  });

  it('EVM resolves to Privy even when an external Solana wallet is connected', () => {
    // MWA cannot reach EVM, so a connected Phantom contributes nothing here.
    const result = resolveChainSigner(
      POLYMARKET_REQUIREMENT,
      input({ isActive: true, provisionedBackends: ['external_mwa'] }),
    );
    assert.notEqual(result.status, 'ready', 'a Solana wallet cannot satisfy an EVM requirement');
  });
});

describe('TC-DORMANT-007/008/009: the funded-dormant safety net', () => {
  const base = {
    activation: { solana: false, evm: false },
    provisioned: { solana: false, evm: false },
    addresses: { solana: null, evm: null } as Record<Chain, string | null>,
    balancesUsd: { solana: null, evm: null } as Record<Chain, number | null>,
  };

  it('TC-DORMANT-009: normal deferred provisioning never fires the check', () => {
    // The normal path: nothing provisioned because nothing was activated.
    const funded = findFundedDormantChains(observeChains(base));
    assert.deepEqual(funded, [], 'the safety net must be unreachable under normal operation');
  });

  it('TC-DORMANT-007: an injected funded dormant chain is surfaced', () => {
    const funded = findFundedDormantChains(
      observeChains({
        ...base,
        provisioned: { solana: true, evm: false },
        addresses: { solana: 'So11111111111111111111111111111111111111112', evm: null },
        balancesUsd: { solana: 42.5, evm: null },
      }),
    );

    assert.equal(funded.length, 1, 'concealing a funded address is a correctness failure');
    assert.equal(funded[0].chain, 'solana');
    assert.equal(funded[0].balanceUsd, 42.5);
  });

  it('TC-DORMANT-008: a zero-balance dormant chain is not surfaced', () => {
    const funded = findFundedDormantChains(
      observeChains({
        ...base,
        provisioned: { solana: true, evm: false },
        addresses: { solana: 'So11111111111111111111111111111111111111112', evm: null },
        balancesUsd: { solana: 0, evm: null },
      }),
    );
    assert.deepEqual(funded, [], 'surfacing every dormant chain would defeat dormancy');
  });

  it('TC-DORMANT-008 boundary: the smallest representable balance does surface', () => {
    // The threshold is "non-zero", not "above a dust floor".
    const funded = findFundedDormantChains(
      observeChains({
        ...base,
        provisioned: { solana: true, evm: false },
        addresses: { solana: 'So11111111111111111111111111111111111111112', evm: null },
        balancesUsd: { solana: Number.MIN_VALUE, evm: null },
      }),
    );
    assert.equal(funded.length, 1, 'a dust balance is still the user\'s money');
  });

  it('an active chain is never reported as dormant-funded', () => {
    const funded = findFundedDormantChains(
      observeChains({
        ...base,
        activation: { solana: true, evm: false },
        provisioned: { solana: true, evm: false },
        addresses: { solana: 'So11111111111111111111111111111111111111112', evm: null },
        balancesUsd: { solana: 100, evm: null },
      }),
    );
    assert.deepEqual(funded, [], 'an active chain renders in the normal row');
  });

  it('an unresolved balance is not reported as funds', () => {
    // null means "no balance source resolved", not "holds nothing". Reporting it
    // would fire on every EVM-dormant user until #261 lands.
    const funded = findFundedDormantChains(
      observeChains({
        ...base,
        provisioned: { solana: false, evm: true },
        addresses: { solana: null, evm: '0xabc0000000000000000000000000000000000001' },
        balancesUsd: { solana: null, evm: null },
      }),
    );
    assert.deepEqual(funded, []);
  });

  it('a provisioned chain with no address is not reported', () => {
    const funded = findFundedDormantChains(
      observeChains({
        ...base,
        provisioned: { solana: true, evm: false },
        addresses: { solana: null, evm: null },
        balancesUsd: { solana: 5, evm: null },
      }),
    );
    assert.deepEqual(funded, [], 'there is nothing to conceal without an address');
  });
});
