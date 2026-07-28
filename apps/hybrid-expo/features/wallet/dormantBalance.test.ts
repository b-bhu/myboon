/**
 * Unit tests for the funded-dormant-chain safety net (issue #248).
 *
 * Covers the detection branch table, the "never fires under normal deferred
 * provisioning" invariant, and the provisioning-bug log line.
 *
 * Run: pnpm --filter hybrid-expo test:wallet
 *
 * Only React-free modules are imported. The HomeScreen wiring and
 * `DormantChainNotice` rendering are verified on device, not here.
 */

import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

import {
  findFundedDormantChains,
  observeChains,
  reportFundedDormantChains,
  type DormantChainObservation,
} from './dormantBalance';
import { EMPTY_ACTIVATION } from '@/features/chain/activation';

const SOLANA_ADDRESS = 'So11111111111111111111111111111111111111112';
const EVM_ADDRESS = '0x1234567890abcdef1234567890abcdef12345678';

function observation(
  overrides: Partial<DormantChainObservation> = {},
): DormantChainObservation {
  return {
    chain: 'solana',
    isProvisioned: false,
    isActive: false,
    address: null,
    balanceUsd: null,
    ...overrides,
  };
}

/** The state this check exists to catch: provisioned, dormant, holding funds. */
function fundedDormant(
  overrides: Partial<DormantChainObservation> = {},
): DormantChainObservation {
  return observation({
    isProvisioned: true,
    isActive: false,
    address: SOLANA_ADDRESS,
    balanceUsd: 42.5,
    ...overrides,
  });
}

describe('findFundedDormantChains — the detection branch table', () => {
  it('flags a provisioned, dormant chain holding a measured balance', () => {
    const funded = findFundedDormantChains([fundedDormant()]);
    assert.equal(funded.length, 1);
    assert.equal(funded[0].chain, 'solana');
    assert.equal(funded[0].address, SOLANA_ADDRESS);
    assert.equal(funded[0].balanceUsd, 42.5);
  });

  it('ignores an active chain — it already renders in the normal ChainRow', () => {
    assert.deepEqual(findFundedDormantChains([fundedDormant({ isActive: true })]), []);
  });

  it('ignores a chain that is not provisioned', () => {
    assert.deepEqual(
      findFundedDormantChains([fundedDormant({ isProvisioned: false })]),
      [],
    );
  });

  it('ignores a provisioned chain with no address — nothing can be concealed', () => {
    assert.deepEqual(findFundedDormantChains([fundedDormant({ address: null })]), []);
  });

  it('ignores a dormant chain whose balance is zero', () => {
    assert.deepEqual(findFundedDormantChains([fundedDormant({ balanceUsd: 0 })]), []);
  });

  it('treats a null balance as unknown, not as funds', () => {
    // Null means no balance source resolved. Prompting on an unknown would fire
    // on every EVM-dormant user until a client-side EVM balance source lands.
    assert.deepEqual(findFundedDormantChains([fundedDormant({ balanceUsd: null })]), []);
  });

  it('ignores non-finite and negative balances rather than reporting them as funds', () => {
    for (const balanceUsd of [Number.NaN, Number.POSITIVE_INFINITY, -5]) {
      assert.deepEqual(
        findFundedDormantChains([fundedDormant({ balanceUsd })]),
        [],
        `expected ${String(balanceUsd)} not to count as funds`,
      );
    }
  });

  it('reports every funded dormant chain, not just the first', () => {
    const funded = findFundedDormantChains([
      fundedDormant(),
      fundedDormant({ chain: 'evm', address: EVM_ADDRESS, balanceUsd: 10 }),
    ]);
    assert.deepEqual(funded.map((entry) => entry.chain), ['solana', 'evm']);
  });

  it('returns nothing for an empty observation list', () => {
    assert.deepEqual(findFundedDormantChains([]), []);
  });
});

describe('the invariant: normal deferred provisioning never fires the check', () => {
  it('finds nothing when dormant chains have no wallet and no address', () => {
    // This is the expected production state: the user activated Solana, EVM was
    // never provisioned, so EVM has no address and cannot hold anything.
    const observations = observeChains({
      activation: { solana: true, evm: false },
      provisioned: { solana: true, evm: false },
      addresses: { solana: SOLANA_ADDRESS, evm: null },
      balancesUsd: { solana: 1234, evm: null },
    });
    assert.deepEqual(findFundedDormantChains(observations), []);
  });

  it('finds nothing when no chain is active or provisioned at all', () => {
    const observations = observeChains({
      activation: EMPTY_ACTIVATION,
      provisioned: { solana: false, evm: false },
      addresses: { solana: null, evm: null },
      balancesUsd: { solana: null, evm: null },
    });
    assert.deepEqual(findFundedDormantChains(observations), []);
  });

  it('fires when provisioning leaked: a dormant chain has an address and funds', () => {
    // The regression case — createOnLogin flipped back on, or the activation
    // path provisioned without recording intent.
    const observations = observeChains({
      activation: { solana: false, evm: true },
      provisioned: { solana: true, evm: true },
      addresses: { solana: SOLANA_ADDRESS, evm: EVM_ADDRESS },
      balancesUsd: { solana: 99.99, evm: null },
    });
    const funded = findFundedDormantChains(observations);
    assert.equal(funded.length, 1);
    assert.equal(funded[0].chain, 'solana');
  });

  it('activating the flagged chain clears it from the detection result', () => {
    // Acceptance criterion: activating from the prompt moves the chain to active,
    // after which the notice stops matching and the balance renders in ChainRow.
    const before = observeChains({
      activation: { solana: false, evm: false },
      provisioned: { solana: true, evm: false },
      addresses: { solana: SOLANA_ADDRESS, evm: null },
      balancesUsd: { solana: 99.99, evm: null },
    });
    assert.equal(findFundedDormantChains(before).length, 1);

    const after = observeChains({
      activation: { solana: true, evm: false },
      provisioned: { solana: true, evm: false },
      addresses: { solana: SOLANA_ADDRESS, evm: null },
      balancesUsd: { solana: 99.99, evm: null },
    });
    assert.deepEqual(findFundedDormantChains(after), []);
  });

  it('cannot flag EVM today — no client-side EVM balance source exists (#261)', () => {
    // Even fully provisioned and dormant, EVM's balance is null, so it is
    // reported as unknown rather than as a fabricated zero or a false positive.
    const observations = observeChains({
      activation: EMPTY_ACTIVATION,
      provisioned: { solana: false, evm: true },
      addresses: { solana: null, evm: EVM_ADDRESS },
      balancesUsd: { solana: null, evm: null },
    });
    assert.deepEqual(findFundedDormantChains(observations), []);
  });
});

describe('observeChains', () => {
  it('produces one observation per chain, carrying the observed values through', () => {
    const observations = observeChains({
      activation: { solana: true, evm: false },
      provisioned: { solana: true, evm: true },
      addresses: { solana: SOLANA_ADDRESS, evm: EVM_ADDRESS },
      balancesUsd: { solana: 5, evm: null },
    });

    assert.deepEqual(observations.map((entry) => entry.chain), ['solana', 'evm']);
    assert.deepEqual(observations[0], {
      chain: 'solana',
      isProvisioned: true,
      isActive: true,
      address: SOLANA_ADDRESS,
      balanceUsd: 5,
    });
    assert.equal(observations[1].isActive, false);
    assert.equal(observations[1].balanceUsd, null);
  });
});

describe('reportFundedDormantChains — observability', () => {
  it('logs a line identifying the fired check as a provisioning bug', () => {
    const warn = mock.method(console, 'warn', () => {});
    try {
      reportFundedDormantChains([
        { chain: 'solana', address: SOLANA_ADDRESS, balanceUsd: 42.5 },
      ]);

      assert.equal(warn.mock.callCount(), 1);
      const [message, payload] = warn.mock.calls[0].arguments as [string, Record<string, unknown>];
      assert.match(message, /PROVISIONING BUG/);
      assert.match(message, /\[wallet\]\[dormancy\]/);
      assert.equal(payload.chain, 'solana');
      assert.equal(payload.balanceUsd, 42.5);
    } finally {
      warn.mock.restore();
    }
  });

  it('truncates the address and logs no key material', () => {
    const warn = mock.method(console, 'warn', () => {});
    try {
      reportFundedDormantChains([
        { chain: 'solana', address: SOLANA_ADDRESS, balanceUsd: 1 },
      ]);
      const [, payload] = warn.mock.calls[0].arguments as [string, Record<string, unknown>];
      assert.notEqual(payload.address, SOLANA_ADDRESS);
      assert.equal(payload.address, 'So1111…1112');
    } finally {
      warn.mock.restore();
    }
  });

  it('logs one line per funded chain', () => {
    const warn = mock.method(console, 'warn', () => {});
    try {
      reportFundedDormantChains([
        { chain: 'solana', address: SOLANA_ADDRESS, balanceUsd: 1 },
        { chain: 'evm', address: EVM_ADDRESS, balanceUsd: 2 },
      ]);
      assert.equal(warn.mock.callCount(), 2);
    } finally {
      warn.mock.restore();
    }
  });

  it('logs nothing when the check did not fire', () => {
    const warn = mock.method(console, 'warn', () => {});
    try {
      reportFundedDormantChains([]);
      assert.equal(warn.mock.callCount(), 0);
    } finally {
      warn.mock.restore();
    }
  });
});
