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
  /** Sign-and-broadcast, not sign-only. See `BackendCapabilities.canBroadcastTransaction`. */
  needsBroadcastTransaction?: boolean;
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
  canBroadcastTransaction: boolean;
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
  /**
   * Sign and broadcast a transaction, returning its hash once submitted.
   * Throws for a descriptor with `canBroadcastTransaction: false` — check the
   * descriptor before calling, the same as any other capability-gated method
   * on this interface.
   */
  sendTransaction(tx: {
    to: string;
    data?: string;
    value?: bigint;
    chainId?: number;
  }): Promise<string>;
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
  /**
   * Sign AND broadcast a transaction, returning a hash the caller can poll —
   * distinct from `canSendTransaction`, which despite its name backs
   * `Signer.signTransaction()` (sign-only, returns a raw signed transaction
   * for the caller to broadcast itself). Added for `@polymarket/client`'s
   * `Signer.sendTransaction()`, which needs the embedded wallet to submit the
   * transaction directly — Privy's embedded wallet exposes broadcast via
   * `eth_sendTransaction`, not raw-signed export.
   */
  canBroadcastTransaction: boolean;
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
      canBroadcastTransaction: false, // no EIP-1193 sendTransaction on Solana
      survivesReinstall: true,
      survivesDeviceLoss: true,
    },
    evm: {
      canSignMessage: true,
      canSignTypedData: true,
      canSendTransaction: true,
      canBroadcastTransaction: true,
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
      canBroadcastTransaction: false,
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
  if (requirement.needsBroadcastTransaction && !capabilities.canBroadcastTransaction) return false;
  return true;
}

/**
 * Every backend that could satisfy this requirement. Empty means `unsupported`.
 *
 * The table lookup is guarded rather than indexed directly. `Chain` is a closed
 * union today so TypeScript prevents an unregistered value, but adding a chain
 * without a `CHAIN_BACKENDS` entry would otherwise throw a `TypeError` here —
 * at exactly the moment the resolver is supposed to degrade to `unsupported`
 * with a readable reason. Cheap insurance for the next person extending this.
 */
export function backendsForRequirement(
  requirement: ChainRequirement,
): readonly WalletBackend[] {
  const backends = CHAIN_BACKENDS[requirement.chain];
  if (!backends) return [];
  return backends.filter((backend) => backendSatisfies(backend, requirement));
}

/**
 * Human-readable explanation of why nothing can satisfy this requirement.
 * Returned as `reason` alongside `status: 'unsupported'` — the resolver never
 * throws for an unsatisfiable requirement.
 */
export function unsupportedReason(requirement: ChainRequirement): string {
  // Falls back to the raw chain value rather than mislabelling an unregistered
  // chain as Solana, and guards the lookup for the same reason as
  // `backendsForRequirement` — this function's contract is that the resolver
  // never throws for an unsatisfiable requirement.
  const chainLabel =
    requirement.chain === 'evm' ? 'EVM' : requirement.chain === 'solana' ? 'Solana' : requirement.chain;
  const supportsChain = (CHAIN_BACKENDS[requirement.chain] ?? []).length > 0;

  if (!supportsChain) {
    return `No wallet backend in this app can sign on ${chainLabel}.`;
  }
  if (requirement.needsTypedData) {
    return `No available ${chainLabel} wallet can sign typed data (EIP-712), which ${requirement.applicationId} requires.`;
  }
  if (requirement.needsRawTransaction) {
    return `No available ${chainLabel} wallet can sign transactions, which ${requirement.applicationId} requires.`;
  }
  if (requirement.needsBroadcastTransaction) {
    return `No available ${chainLabel} wallet can send transactions, which ${requirement.applicationId} requires.`;
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
    canBroadcastTransaction: capabilities.canBroadcastTransaction,
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
  // @polymarket/client's SecureClient sends a real transaction to deploy the
  // deposit wallet the first time a signer sets up an account — see
  // docs/modules/polymarket/PRDs/2026_07_31_polymarket_sdk_migration_PRD.md.
  needsBroadcastTransaction: true,
};
