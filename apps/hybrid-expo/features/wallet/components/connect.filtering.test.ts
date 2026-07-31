/**
 * Connection option filtering, as a derived rule.
 *
 * The spec requires one modal whose options are filtered by chain, "built as a
 * list of available options rather than a Privy-branded screen, so that adding
 * an external EVM transport later is a change to the availability rule and
 * nothing else". These tests assert that property directly: the option list is a
 * function of `CHAIN_BACKENDS`, not a second hardcoded copy of the same fact.
 *
 * Covers: TC-MODAL-001, TC-MODAL-002, TC-MODAL-003 (the single-source half),
 * TC-MODAL-004.
 *
 * Complements `connect.options.test.ts`, which locks the concrete lists. This
 * file tests the *derivation*, which is what makes the extension story true.
 *
 * Run: pnpm --filter hybrid-expo test:wallet
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { availableOptions, BACKEND_OPTIONS, type ConnectOption } from './connect.options';
import {
  CHAIN_BACKENDS,
  CHAINS,
  WALLET_BACKENDS,
  type Chain,
  type WalletBackend,
} from '@/features/chain/chain.contract';

/**
 * Recompute the option list from a *substituted* backend table.
 *
 * This mirrors `availableOptions` exactly, but takes the chain→backend mapping
 * as a parameter. It is how TC-MODAL-004 is tested without editing the shipped
 * table: flip external support on for EVM in a local copy and confirm the modal
 * would gain a row. Nothing here mutates module state, so the test leaves no
 * residue — the "revert the flip" step of TC-MODAL-004 is structural rather than
 * something that could be forgotten.
 */
function optionsFrom(
  backends: Record<Chain, readonly WalletBackend[]>,
  chain: Chain,
): readonly ConnectOption[] {
  const order: readonly ConnectOption[] = ['email', 'google', 'external_wallet'];
  const offered = new Set<ConnectOption>();
  for (const backend of backends[chain]) {
    for (const option of BACKEND_OPTIONS[backend]) offered.add(option);
  }
  return order.filter((option) => offered.has(option));
}

describe('TC-MODAL-001/002: option filtering per chain', () => {
  it('Solana offers the external wallet row', () => {
    assert.ok(
      availableOptions('solana').includes('external_wallet'),
      'Solana has an external transport and must offer it',
    );
  });

  it('EVM drops the external wallet row and nothing else', () => {
    const solana = new Set(availableOptions('solana'));
    const evm = new Set(availableOptions('evm'));

    assert.equal(evm.has('external_wallet'), false, 'MWA cannot reach EVM');

    // The EVM list is exactly the Solana list minus the external row — the case
    // differs in the length of the option array, not in kind.
    const dropped = [...solana].filter((option) => !evm.has(option));
    assert.deepEqual(dropped, ['external_wallet']);
  });

  it('the external wallet option is absent, not present-and-disabled', () => {
    // An unavailable option must not appear at all. A greyed row invites the
    // user to tap something that can never work, and would imply Phantom is at
    // fault when the limitation is the transport.
    const options = availableOptions('evm');
    assert.equal(
      options.includes('external_wallet'),
      false,
      'absent from the list, not rendered disabled',
    );
    // The list carries no disabled/availability metadata at all — it is a plain
    // list of things that work, which is what makes "absent" the only option.
    for (const option of options) {
      assert.equal(typeof option, 'string');
    }
  });

  it('Privy is offered on every chain', () => {
    for (const chain of CHAINS) {
      const options = availableOptions(chain);
      assert.ok(options.includes('email'), `${chain} must offer email`);
      assert.ok(options.includes('google'), `${chain} must offer google`);
    }
  });

  it('every chain offers at least one option — no dead-end modal', () => {
    for (const chain of CHAINS) {
      assert.ok(
        availableOptions(chain).length > 0,
        `${chain} would open a modal with nothing in it`,
      );
    }
  });

  it('returns no duplicate options', () => {
    for (const chain of CHAINS) {
      const options = availableOptions(chain);
      assert.equal(new Set(options).size, options.length, `${chain} has a duplicate row`);
    }
  });
});

describe('TC-MODAL-003: one modal, driven by data', () => {
  it('the option list is fully derived from CHAIN_BACKENDS', () => {
    // If this passes, no second copy of "EVM has no external wallet" exists in
    // the sheet. That is what keeps the two renders one component.
    for (const chain of CHAINS) {
      const expected = new Set(
        CHAIN_BACKENDS[chain].flatMap((backend) => [...BACKEND_OPTIONS[backend]]),
      );
      assert.deepEqual(new Set(availableOptions(chain)), expected, chain);
    }
  });

  it('every backend contributes at least one option', () => {
    // A backend with no options would be unreachable from the modal — present in
    // the capability table but impossible for a user to choose.
    for (const backend of WALLET_BACKENDS) {
      assert.ok(
        BACKEND_OPTIONS[backend].length > 0,
        `${backend} contributes no option and cannot be chosen`,
      );
    }
  });

  it('option order is stable across chains and calls', () => {
    // The rows must not reshuffle between two renders of the same modal.
    for (const chain of CHAINS) {
      assert.deepEqual(availableOptions(chain), availableOptions(chain));
    }
    // And the relative order is consistent between the two chains.
    const solana = availableOptions('solana').filter((o) => o !== 'external_wallet');
    assert.deepEqual(solana, [...availableOptions('evm')]);
  });
});

describe('TC-MODAL-004: adding an external EVM transport is a rule change only', () => {
  it('flipping external support on for EVM yields the external row', () => {
    const withExternalEvm: Record<Chain, readonly WalletBackend[]> = {
      solana: CHAIN_BACKENDS.solana,
      evm: ['external_mwa', 'privy_embedded'],
    };

    const options = optionsFrom(withExternalEvm, 'evm');
    assert.ok(
      options.includes('external_wallet'),
      'the modal gains the row from the availability rule alone',
    );
    assert.deepEqual(
      new Set(options),
      new Set(availableOptions('solana')),
      'EVM would then offer exactly what Solana offers',
    );
  });

  it('the shipped table is unchanged by that exercise — no residue', () => {
    // The substitution above is a local copy; the real table must be untouched.
    assert.deepEqual([...CHAIN_BACKENDS.evm], ['privy_embedded']);
    assert.deepEqual([...CHAIN_BACKENDS.solana], ['external_mwa', 'privy_embedded']);
    assert.equal(availableOptions('evm').includes('external_wallet'), false);
  });

  it('the derivation, not the sheet, is what changes', () => {
    // Same function, same inputs shape, different table -> different list.
    // Nothing about the rendering path participates in the decision.
    const current = optionsFrom(CHAIN_BACKENDS, 'evm');
    assert.deepEqual([...current], [...availableOptions('evm')]);
  });
});
