/**
 * chain.signers — `Signer` construction from a resolved backend.
 *
 * Deliberately free of React and of the Privy SDK: each factory takes the
 * primitive it needs (an EIP-1193 `request`, or a Solana `signMessage`) and
 * returns a `Signer`. That keeps descriptor flags and capability errors unit
 * testable without a renderer or a live wallet.
 *
 * No module-level mutable signer exists here. A signer is always constructed
 * for the caller that asked, per the spec's governing rules.
 */

import {
  buildSignerDescriptor,
  type Chain,
  type Signer,
  type SignerDescriptor,
} from '@/features/chain/chain.contract';

export type Eip1193Request = <T = unknown>(args: {
  method: string;
  params?: unknown[];
}) => Promise<T>;

function unsupported(descriptor: SignerDescriptor, capability: string): never {
  throw new Error(
    `${descriptor.backend} on ${descriptor.chain} cannot ${capability}.`,
  );
}

/** Hex-encode bytes for `personal_sign`, which takes a 0x-prefixed message. */
function toHex(message: string | Uint8Array): string {
  const bytes =
    typeof message === 'string' ? new TextEncoder().encode(message) : message;
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return `0x${hex}`;
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

/**
 * Signer over a Privy embedded EVM wallet, via its EIP-1193 provider.
 */
export function createPrivyEvmSigner(params: {
  address: string;
  chainId?: number;
  request: Eip1193Request;
}): Signer {
  const descriptor = buildSignerDescriptor({
    backend: 'privy_embedded',
    chain: 'evm',
    address: params.address,
    chainId: params.chainId,
  });

  return {
    descriptor,
    getAddress: async () => descriptor.address,

    signMessage: async (message) =>
      params.request<string>({
        method: 'personal_sign',
        params: [toHex(message), descriptor.address],
      }),

    signTypedData: async (domain, types, value) => {
      // `eth_signTypedData_v4` takes the full EIP-712 payload as a JSON string.
      //
      // The primary type is the struct nothing else references. Picking the
      // first non-EIP712Domain key instead breaks any nested type set:
      // Polymarket's deposit-wallet batch declares `Call` before `Batch`, so
      // that would sign the wrong struct — a wrong-but-valid signature the
      // contract rejects, which is far worse than an error.
      const candidates = Object.keys(types).filter((key) => key !== 'EIP712Domain');
      const referenced = new Set(
        candidates.flatMap((key) =>
          (types[key] ?? []).map((field) => field.type.replace(/\[\]$/, '')),
        ),
      );
      const primaryType = candidates.find((key) => !referenced.has(key)) ?? candidates[0];
      if (!primaryType) {
        throw new Error('signTypedData requires a primary type besides EIP712Domain.');
      }
      // The domain type must describe exactly the fields the domain actually
      // carries. A fixed four-field list declared `verifyingContract` even when
      // the domain omitted it — Polymarket's `ClobAuthDomain` is name/version/
      // chainId only — and the signer then tried to encode `undefined` as an
      // address, failing with `Address "undefined" is invalid`. Deriving the
      // list from the domain's own keys keeps the two in step for any domain.
      const EIP712_DOMAIN_FIELD_TYPES: Record<string, string> = {
        name: 'string',
        version: 'string',
        chainId: 'uint256',
        verifyingContract: 'address',
        salt: 'bytes32',
      };
      const domainType =
        types.EIP712Domain
        ?? Object.keys(EIP712_DOMAIN_FIELD_TYPES)
          .filter((field) => domain[field] !== undefined)
          .map((field) => ({ name: field, type: EIP712_DOMAIN_FIELD_TYPES[field] }));

      const payload = {
        domain,
        types: {
          ...types,
          EIP712Domain: domainType,
        },
        primaryType,
        message: value,
      };
      return params.request<string>({
        method: 'eth_signTypedData_v4',
        params: [descriptor.address, JSON.stringify(payload)],
      });
    },

    signTransaction: async (tx) =>
      params.request<string>({
        method: 'eth_signTransaction',
        params: [{ from: descriptor.address, ...tx }],
      }),
  };
}

/**
 * Signer over a Solana wallet — either a Privy embedded wallet or an external
 * wallet reached through MWA. Both expose the same `signMessage(bytes)`
 * primitive, so one factory covers both and the backend is passed in.
 *
 * EIP-712 has no meaning on Solana: `signTypedData` throws rather than
 * pretending. The resolver never routes a `needsTypedData` requirement here —
 * `backendSatisfies` rejects it first and the caller gets `unsupported` with a
 * reason instead of an exception.
 */
export function createSolanaSigner(params: {
  backend: 'privy_embedded' | 'external_mwa';
  address: string;
  signMessage: (message: Uint8Array) => Promise<Uint8Array>;
  signTransaction?: (tx: Record<string, unknown>) => Promise<string>;
}): Signer {
  const descriptor = buildSignerDescriptor({
    backend: params.backend,
    chain: 'solana' satisfies Chain,
    address: params.address,
  });

  return {
    descriptor,
    getAddress: async () => descriptor.address,

    signMessage: async (message) => {
      const bytes =
        typeof message === 'string' ? new TextEncoder().encode(message) : message;
      const signature = await params.signMessage(bytes);
      return toBase64(signature);
    },

    signTypedData: async () => unsupported(descriptor, 'sign EIP-712 typed data'),

    signTransaction: async (tx) => {
      if (!params.signTransaction) {
        return unsupported(descriptor, 'sign raw transactions');
      }
      return params.signTransaction(tx);
    },
  };
}
