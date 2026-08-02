/**
 * The deposit sheet offers exactly the chains this app supports.
 *
 * The bridge (`https://bridge.polymarket.com/deposit`, proxied verbatim by
 * `packages/api/src/polymarket/trading/routes/funds.ts`) returns addresses for
 * chains beyond the two we want, including native-asset routes with different
 * minimums and slower settlement. The client previously rendered every key it
 * received, so those appeared as first-class deposit options.
 *
 * These tests read the component source rather than rendering it: the
 * property that matters is that the list is derived from an explicit
 * allowlist, not filtered ad hoc at the call site, and that no unsupported
 * chain has a rendering entry to fall back on. A render test would pass just
 * as well against a hardcoded filter that the next bridge change defeats.
 *
 * Covers the acceptance criteria of #269.
 *
 * Run: pnpm --filter hybrid-expo test:predict
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SOURCE = readFileSync(join(__dirname, 'DepositModal.tsx'), 'utf8');

describe('deposit sheet chain allowlist', () => {
  it('declares exactly evm and svm, in that order', () => {
    const match = SOURCE.match(/const SUPPORTED_CHAINS = \[([^\]]*)\] as const/);
    assert.ok(match, 'SUPPORTED_CHAINS should be declared as a const tuple');

    const chains = match[1]
      .split(',')
      .map((entry) => entry.trim().replace(/['"]/g, ''))
      .filter(Boolean);

    // Order is the render order — EVM first is a product decision, not
    // incidental, and was previously left to `Object.entries` on the response.
    assert.deepEqual(chains, ['evm', 'svm']);
  });

  it('renders from the allowlist rather than the raw bridge response', () => {
    assert.match(
      SOURCE,
      /SUPPORTED_CHAINS\.flatMap/,
      'the chain list should be derived from SUPPORTED_CHAINS',
    );
    assert.doesNotMatch(
      SOURCE,
      /Object\.entries\(addresses\)/,
      'iterating the bridge response directly re-introduces unsupported chains',
    );
  });

  it('has no rendering metadata for an unsupported chain', () => {
    // A leftover CHAIN_META entry is the failure mode that would let a chain
    // return the moment someone widens the list without thinking.
    for (const unsupported of ['btc', 'tron', 'bitcoin']) {
      assert.doesNotMatch(
        SOURCE,
        new RegExp(`^\\s*${unsupported}:\\s*\\{`, 'im'),
        `CHAIN_META should not define an entry for "${unsupported}"`,
      );
    }
  });

  it('handles a response carrying no supported chain', () => {
    // Otherwise the sheet renders a blank gap between subtitle and footer,
    // which reads as broken rather than as a transient upstream state.
    assert.match(
      SOURCE,
      /chains\.length === 0/,
      'an empty supported-chain list should render an explicit message',
    );
  });
});
