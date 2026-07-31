/**
 * Unit tests for the chain connectivity layer.
 *
 * Covers the two acceptance criteria in issue #246 that call for unit coverage:
 * the resolver's four branches, and `SignerDescriptor` flags per backend.
 *
 * Run: pnpm --filter hybrid-expo test:chain
 *
 * Only React-free modules are imported. `useChainSigner` binds these to live
 * wallet state and is verified on device, not here.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  BACKEND_CAPABILITIES,
  POLYMARKET_REQUIREMENT,
  backendSatisfies,
  backendsForRequirement,
  buildSignerDescriptor,
  getBackendCapabilities,
  unsupportedReason,
  type ChainRequirement,
} from './chain.contract';
import {
  resolveChainSigner,
  type ResolutionInput,
} from './chain.resolution';
import { createPrivyEvmSigner, createSolanaSigner } from './chain.signers';

const SOLANA_REQUIREMENT: ChainRequirement = {
  applicationId: 'perps',
  chain: 'solana',
  needsTypedData: false,
  needsRawTransaction: true,
};

/** A requirement no backend can satisfy: EIP-712 typed data on Solana. */
const IMPOSSIBLE_REQUIREMENT: ChainRequirement = {
  applicationId: 'hypothetical',
  chain: 'solana',
  needsTypedData: true,
  needsRawTransaction: false,
};

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

describe('resolveChainSigner — the four branches', () => {
  it('branch 1: chain active and provisioned -> ready', () => {
    const result = resolveChainSigner(
      POLYMARKET_REQUIREMENT,
      input({ isActive: true, provisionedBackends: ['privy_embedded'] }),
    );
    assert.equal(result.status, 'ready');
    assert.equal(result.reason, null);
    assert.equal(result.backend, 'privy_embedded');
    assert.equal(result.needsActivation, false);
  });

  it('branch 2: provisioned but dormant -> needs_connection flagged for activation', () => {
    const result = resolveChainSigner(
      POLYMARKET_REQUIREMENT,
      input({ isActive: false, provisionedBackends: ['privy_embedded'] }),
    );
    assert.equal(result.status, 'needs_connection');
    assert.equal(result.needsActivation, true);
    assert.equal(result.backend, 'privy_embedded');
  });

  it('branch 2: activating the dormant chain makes the same input ready', () => {
    const dormant = input({ isActive: false, provisionedBackends: ['privy_embedded'] });
    assert.equal(resolveChainSigner(POLYMARKET_REQUIREMENT, dormant).status, 'needs_connection');

    const activated = { ...dormant, isActive: true };
    assert.equal(resolveChainSigner(POLYMARKET_REQUIREMENT, activated).status, 'ready');
  });

  it('branch 3: neither active nor provisioned -> needs_connection', () => {
    const result = resolveChainSigner(POLYMARKET_REQUIREMENT, input());
    assert.equal(result.status, 'needs_connection');
    assert.equal(result.needsActivation, false);
    assert.equal(result.backend, null);
  });

  it('branch 4: no backend can satisfy -> unsupported with a non-null reason', () => {
    const result = resolveChainSigner(IMPOSSIBLE_REQUIREMENT, input());
    assert.equal(result.status, 'unsupported');
    assert.notEqual(result.reason, null);
    assert.ok((result.reason as string).length > 0);
    assert.equal(result.backend, null);
  });

  it('branch 4 does not throw, and wins over session state', () => {
    // Even fully active and provisioned, an unsatisfiable requirement resolves
    // to unsupported rather than handing back a signer that cannot do the job.
    assert.doesNotThrow(() => {
      const result = resolveChainSigner(
        IMPOSSIBLE_REQUIREMENT,
        input({ isActive: true, provisionedBackends: ['external_mwa', 'privy_embedded'] }),
      );
      assert.equal(result.status, 'unsupported');
      assert.notEqual(result.reason, null);
    });
  });

  it('reports preparing until activation is hydrated, never needs_connection', () => {
    // Re-prompting a user who already activated is the stickiness failure the
    // spec forbids, so the pre-hydration state must not be needs_connection.
    const result = resolveChainSigner(
      POLYMARKET_REQUIREMENT,
      input({ isActivationHydrated: false, isActive: true, provisionedBackends: ['privy_embedded'] }),
    );
    assert.equal(result.status, 'preparing');
  });

  it('reports preparing while a create()/authorize() call is in flight', () => {
    const result = resolveChainSigner(
      POLYMARKET_REQUIREMENT,
      input({ isBusy: true, isActive: true, provisionedBackends: ['privy_embedded'] }),
    );
    assert.equal(result.status, 'preparing');
  });

  it('active with nothing provisioned: preparing for a Privy user who can provision', () => {
    const result = resolveChainSigner(
      POLYMARKET_REQUIREMENT,
      input({ isActive: true, provisionedBackends: [], canProvisionOnDemand: true }),
    );
    assert.equal(result.status, 'preparing');
  });

  it('active with nothing provisioned: needs_connection when nothing can provision', () => {
    const result = resolveChainSigner(
      POLYMARKET_REQUIREMENT,
      input({ isActive: true, provisionedBackends: [], canProvisionOnDemand: false }),
    );
    assert.equal(result.status, 'needs_connection');
  });

  it('prefers an external Solana wallet over Privy when both are provisioned', () => {
    const result = resolveChainSigner(
      SOLANA_REQUIREMENT,
      input({ isActive: true, provisionedBackends: ['external_mwa', 'privy_embedded'] }),
    );
    assert.equal(result.status, 'ready');
    assert.equal(result.backend, 'external_mwa');
  });

  it('a second EVM application resolves with no resolver change', () => {
    const secondEvmApp: ChainRequirement = {
      applicationId: 'hypothetical-evm-app',
      chain: 'evm',
      chainId: 8453,
      needsTypedData: true,
      needsRawTransaction: true,
    };
    const result = resolveChainSigner(
      secondEvmApp,
      input({ isActive: true, provisionedBackends: ['privy_embedded'] }),
    );
    assert.equal(result.status, 'ready');
    assert.equal(result.backend, 'privy_embedded');
  });
});

describe('backend eligibility', () => {
  it('MWA cannot reach EVM — Privy is the only EVM backend', () => {
    assert.deepEqual(backendsForRequirement(POLYMARKET_REQUIREMENT), ['privy_embedded']);
    assert.equal(getBackendCapabilities('external_mwa', 'evm'), null);
    assert.equal(backendSatisfies('external_mwa', POLYMARKET_REQUIREMENT), false);
  });

  it('both backends can satisfy a plain Solana requirement', () => {
    assert.deepEqual(backendsForRequirement(SOLANA_REQUIREMENT), [
      'external_mwa',
      'privy_embedded',
    ]);
  });

  it('no Solana backend can satisfy a typed-data requirement', () => {
    assert.deepEqual(backendsForRequirement(IMPOSSIBLE_REQUIREMENT), []);
  });

  it('unsupportedReason returns a non-empty human-readable string', () => {
    const reason = unsupportedReason(IMPOSSIBLE_REQUIREMENT);
    assert.ok(reason.length > 0);
    assert.ok(reason.includes('Solana'));
    assert.ok(reason.includes('hypothetical'));
  });
});

describe('SignerDescriptor flags per backend', () => {
  it('privy_embedded on evm: full capability, survives reinstall and device loss', () => {
    const descriptor = buildSignerDescriptor({
      backend: 'privy_embedded',
      chain: 'evm',
      address: '0x1111111111111111111111111111111111111111',
      chainId: 137,
    });
    assert.equal(descriptor.backend, 'privy_embedded');
    assert.equal(descriptor.chain, 'evm');
    assert.equal(descriptor.chainId, 137);
    assert.equal(descriptor.canSignMessage, true);
    assert.equal(descriptor.canSignTypedData, true);
    assert.equal(descriptor.canSendTransaction, true);
    assert.equal(descriptor.canBroadcastTransaction, true);
    assert.equal(descriptor.survivesReinstall, true);
    assert.equal(descriptor.survivesDeviceLoss, true);
  });

  it('privy_embedded is survivesReinstall and survivesDeviceLoss on every chain it supports', () => {
    for (const [chain, capabilities] of Object.entries(
      BACKEND_CAPABILITIES.privy_embedded,
    )) {
      assert.equal(capabilities.survivesReinstall, true, `${chain} survivesReinstall`);
      assert.equal(capabilities.survivesDeviceLoss, true, `${chain} survivesDeviceLoss`);
    }
  });

  it('solana descriptors cannot sign typed data — EIP-712 is an EVM concept', () => {
    for (const backend of ['privy_embedded', 'external_mwa'] as const) {
      const descriptor = buildSignerDescriptor({
        backend,
        chain: 'solana',
        address: 'So11111111111111111111111111111111111111112',
      });
      assert.equal(descriptor.canSignTypedData, false, backend);
      assert.equal(descriptor.canSignMessage, true, backend);
    }
  });

  it('omits chainId entirely when none is given, rather than setting undefined', () => {
    const descriptor = buildSignerDescriptor({
      backend: 'external_mwa',
      chain: 'solana',
      address: 'So11111111111111111111111111111111111111112',
    });
    assert.equal('chainId' in descriptor, false);
  });

  it('throws when a backend does not support the chain at all', () => {
    assert.throws(
      () =>
        buildSignerDescriptor({
          backend: 'external_mwa',
          chain: 'evm',
          address: '0x1111111111111111111111111111111111111111',
        }),
      /does not support chain evm/,
    );
  });
});

describe('signer construction', () => {
  it('EVM signMessage issues personal_sign with a hex message and the address', async () => {
    const calls: { method: string; params?: unknown[] }[] = [];
    const signer = createPrivyEvmSigner({
      address: '0xabc0000000000000000000000000000000000001',
      chainId: 137,
      request: async (args) => {
        calls.push(args);
        return '0xsignature' as never;
      },
    });

    const signature = await signer.signMessage('hi');
    assert.equal(signature, '0xsignature');
    assert.equal(calls[0].method, 'personal_sign');
    // 'hi' -> 0x6869
    assert.deepEqual(calls[0].params, [
      '0x6869',
      '0xabc0000000000000000000000000000000000001',
    ]);
  });

  it('EVM signTypedData issues eth_signTypedData_v4 with the inferred primary type', async () => {
    const calls: { method: string; params?: unknown[] }[] = [];
    const signer = createPrivyEvmSigner({
      address: '0xabc0000000000000000000000000000000000001',
      chainId: 137,
      request: async (args) => {
        calls.push(args);
        return '0xtyped' as never;
      },
    });

    await signer.signTypedData(
      { name: 'Polymarket', chainId: 137 },
      { Order: [{ name: 'maker', type: 'address' }] },
      { maker: '0xabc0000000000000000000000000000000000001' },
    );

    assert.equal(calls[0].method, 'eth_signTypedData_v4');
    const payload = JSON.parse((calls[0].params as string[])[1]);
    assert.equal(payload.primaryType, 'Order');
    assert.equal(payload.domain.chainId, 137);
    assert.ok(payload.types.EIP712Domain, 'EIP712Domain is filled in when omitted');
  });

  it('Solana signTypedData throws rather than pretending EIP-712 works', async () => {
    const signer = createSolanaSigner({
      backend: 'external_mwa',
      address: 'So11111111111111111111111111111111111111112',
      signMessage: async () => new Uint8Array(64),
    });
    await assert.rejects(
      () => signer.signTypedData({}, { Order: [] }, {}),
      /cannot sign EIP-712 typed data/,
    );
  });

  it('Solana signTransaction throws when the backend supplied no implementation', async () => {
    const signer = createSolanaSigner({
      backend: 'privy_embedded',
      address: 'So11111111111111111111111111111111111111112',
      signMessage: async () => new Uint8Array(64),
    });
    await assert.rejects(
      () => signer.signTransaction({}),
      /cannot sign raw transactions/,
    );
  });

  it('getAddress resolves to the descriptor address', async () => {
    const signer = createSolanaSigner({
      backend: 'external_mwa',
      address: 'So11111111111111111111111111111111111111112',
      signMessage: async () => new Uint8Array(64),
    });
    assert.equal(await signer.getAddress(), 'So11111111111111111111111111111111111111112');
  });
});

describe('POLYMARKET_REQUIREMENT', () => {
  it('declares Polygon EIP-712 signing without raw transactions', () => {
    assert.equal(POLYMARKET_REQUIREMENT.applicationId, 'polymarket');
    assert.equal(POLYMARKET_REQUIREMENT.chain, 'evm');
    assert.equal(POLYMARKET_REQUIREMENT.chainId, 137);
    assert.equal(POLYMARKET_REQUIREMENT.needsTypedData, true);
    assert.equal(POLYMARKET_REQUIREMENT.needsRawTransaction, false);
  });
});
