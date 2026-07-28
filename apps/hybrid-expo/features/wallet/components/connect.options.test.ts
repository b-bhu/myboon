/**
 * Tests for the connection sheet's option filtering.
 *
 * These lock the rule that an EVM requirement drops the external-wallet row and
 * nothing else, and that the rule is derived from the backend capability table
 * rather than a second hardcoded copy of the same fact.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { availableOptions, BACKEND_OPTIONS } from './connect.options';
import { CHAIN_BACKENDS } from '@/features/chain/chain.contract';

describe('availableOptions', () => {
  it('offers external wallet, email and passkey on Solana', () => {
    assert.deepEqual(
      [...availableOptions('solana')].sort(),
      ['email', 'external_wallet', 'passkey'],
    );
  });

  it('drops only the external wallet row on EVM', () => {
    assert.deepEqual([...availableOptions('evm')].sort(), ['email', 'passkey']);
  });

  it('offers Privy as two auth methods on every chain', () => {
    for (const chain of ['solana', 'evm'] as const) {
      const options = availableOptions(chain);
      assert.ok(options.includes('email'), `${chain} should offer email`);
      assert.ok(options.includes('passkey'), `${chain} should offer passkey`);
    }
  });

  it('derives availability from CHAIN_BACKENDS rather than a hardcoded list', () => {
    // If MWA ever gained EVM support, the wallet row would appear on EVM with no
    // change to this module. That is the property the sheet relies on.
    for (const chain of ['solana', 'evm'] as const) {
      const expected = new Set(
        CHAIN_BACKENDS[chain].flatMap((backend) => [...BACKEND_OPTIONS[backend]]),
      );
      assert.deepEqual(new Set(availableOptions(chain)), expected);
    }
  });

  it('returns options in a stable order across calls', () => {
    assert.deepEqual(availableOptions('solana'), availableOptions('solana'));
    assert.deepEqual([...availableOptions('solana')], ['email', 'passkey', 'external_wallet']);
  });
});
