/**
 * chain.contract — the vocabulary of the wallet connectivity layer.
 *
 * Applications declare a `ChainRequirement` and receive a `Signer`, without
 * knowing which backend satisfied it. Descriptors follow the capability style of
 * `features/perps/perps.registry.ts`: a flat record of booleans a feature can
 * read, rather than assumptions hardcoded at each call site.
 *
 * Model: docs/modules/wallet/specs/wallet_connectivity.md
 */

export type Chain = 'solana' | 'evm';

/** The thing that holds key material. There are exactly two. */
export type WalletBackend = 'privy_embedded' | 'external_mwa';

export const CHAINS = ['solana', 'evm'] as const satisfies readonly Chain[];

export const WALLET_BACKENDS = [
  'privy_embedded',
  'external_mwa',
] as const satisfies readonly WalletBackend[];

/**
 * An application's declaration of the chain and signing capabilities it needs.
 * Evaluated by the resolver — applications never reach for a global signer.
 */
export interface ChainRequirement {
  applicationId: string;
  chain: Chain;
  /** EVM only. Ignored for `chain: 'solana'`. */
  chainId?: number;
  needsTypedData: boolean;
  needsRawTransaction: boolean;
}

/**
 * What a resolved signer can do and how durable its key material is.
 *
 * `survivesReinstall` / `survivesDeviceLoss` exist so features decide whether to
 * warn before a user parks value, instead of hardcoding custody assumptions.
 */
export interface SignerDescriptor {
  backend: WalletBackend;
  chain: Chain;
  address: string;
  chainId?: number;
  canSignMessage: boolean;
  canSignTypedData: boolean;
  canSendTransaction: boolean;
  survivesReinstall: boolean;
  survivesDeviceLoss: boolean;
}

export interface Signer {
  descriptor: SignerDescriptor;
  getAddress(): Promise<string>;
  signMessage(message: string | Uint8Array): Promise<string>;
  signTypedData(
    domain: Record<string, unknown>,
    types: Record<string, { name: string; type: string }[]>,
    value: Record<string, unknown>,
  ): Promise<string>;
  signTransaction(tx: Record<string, unknown>): Promise<string>;
}

/**
 * Static capabilities of each backend on each chain.
 *
 * Mobile Wallet Adapter is Solana-only *by specification* — `authorize` accepts
 * only `solana:*` chain identifiers. Phantom holds EVM accounts, but they are
 * unreachable over this transport. That is a property of the transport, not a
 * gap we can close with more code, so `external_mwa` has no `evm` entry and an
 * EVM requirement can only ever be satisfied by Privy.
 */
export interface BackendCapabilities {
  canSignMessage: boolean;
  canSignTypedData: boolean;
  canSendTransaction: boolean;
  survivesReinstall: boolean;
  survivesDeviceLoss: boolean;
}

export const BACKEND_CAPABILITIES: Record<
  WalletBackend,
  Partial<Record<Chain, BackendCapabilities>>
> = {
  privy_embedded: {
    // Privy embedded wallets are recoverable across devices and survive
    // reinstall — key material is held by Privy under the user's identity, not
    // bound to this device.
    solana: {
      canSignMessage: true,
      canSignTypedData: false, // EIP-712 is an EVM concept
      canSendTransaction: true,
      survivesReinstall: true,
      survivesDeviceLoss: true,
    },
    evm: {
      canSignMessage: true,
      canSignTypedData: true,
      canSendTransaction: true,
      survivesReinstall: true,
      survivesDeviceLoss: true,
    },
  },
  external_mwa: {
    // The external wallet app owns the key. Whether it survives reinstall of
    // *our* app is not ours to promise, but the account itself persists in the
    // wallet app and is seed-phrase recoverable, so both flags hold.
    solana: {
      canSignMessage: true,
      canSignTypedData: false,
      canSendTransaction: true,
      survivesReinstall: true,
      survivesDeviceLoss: true,
    },
    // No `evm` key: MWA cannot reach EVM. See doc comment above.
  },
};

/** Backends that can satisfy a given chain at all, in resolution preference order. */
export const CHAIN_BACKENDS: Record<Chain, readonly WalletBackend[]> = {
  solana: ['external_mwa', 'privy_embedded'],
  evm: ['privy_embedded'],
};

export function getBackendCapabilities(
  backend: WalletBackend,
  chain: Chain,
): BackendCapabilities | null {
  return BACKEND_CAPABILITIES[backend][chain] ?? null;
}

/**
 * Whether a backend can satisfy a requirement — chain support plus every
 * capability the requirement actually asks for.
 */
export function backendSatisfies(
  backend: WalletBackend,
  requirement: ChainRequirement,
): boolean {
  const capabilities = getBackendCapabilities(backend, requirement.chain);
  if (!capabilities) return false;
  if (requirement.needsTypedData && !capabilities.canSignTypedData) return false;
  if (requirement.needsRawTransaction && !capabilities.canSendTransaction) return false;
  return true;
}

/** Every backend that could satisfy this requirement. Empty means `unsupported`. */
export function backendsForRequirement(
  requirement: ChainRequirement,
): readonly WalletBackend[] {
  return CHAIN_BACKENDS[requirement.chain].filter((backend) =>
    backendSatisfies(backend, requirement),
  );
}

/**
 * Human-readable explanation of why nothing can satisfy this requirement.
 * Returned as `reason` alongside `status: 'unsupported'` — the resolver never
 * throws for an unsatisfiable requirement.
 */
export function unsupportedReason(requirement: ChainRequirement): string {
  const chainLabel = requirement.chain === 'evm' ? 'EVM' : 'Solana';
  const supportsChain = CHAIN_BACKENDS[requirement.chain].length > 0;

  if (!supportsChain) {
    return `No wallet backend in this app can sign on ${chainLabel}.`;
  }
  if (requirement.needsTypedData) {
    return `No available ${chainLabel} wallet can sign typed data (EIP-712), which ${requirement.applicationId} requires.`;
  }
  if (requirement.needsRawTransaction) {
    return `No available ${chainLabel} wallet can sign transactions, which ${requirement.applicationId} requires.`;
  }
  return `No available wallet backend can satisfy ${requirement.applicationId} on ${chainLabel}.`;
}

/**
 * Build a descriptor from a resolved backend, chain and address. Capability and
 * durability flags come from `BACKEND_CAPABILITIES` so they are stated in one
 * place rather than per call site.
 */
export function buildSignerDescriptor(params: {
  backend: WalletBackend;
  chain: Chain;
  address: string;
  chainId?: number;
}): SignerDescriptor {
  const capabilities = getBackendCapabilities(params.backend, params.chain);
  if (!capabilities) {
    throw new Error(
      `Backend ${params.backend} does not support chain ${params.chain}`,
    );
  }
  return {
    backend: params.backend,
    chain: params.chain,
    address: params.address,
    ...(params.chainId !== undefined ? { chainId: params.chainId } : {}),
    canSignMessage: capabilities.canSignMessage,
    canSignTypedData: capabilities.canSignTypedData,
    canSendTransaction: capabilities.canSendTransaction,
    survivesReinstall: capabilities.survivesReinstall,
    survivesDeviceLoss: capabilities.survivesDeviceLoss,
  };
}

/** Polygon mainnet. Polymarket's CLOB signs EIP-712 orders against this chain. */
export const POLYGON_CHAIN_ID = 137;

export const POLYMARKET_REQUIREMENT: ChainRequirement = {
  applicationId: 'polymarket',
  chain: 'evm',
  chainId: POLYGON_CHAIN_ID,
  needsTypedData: true,
  needsRawTransaction: false,
};
