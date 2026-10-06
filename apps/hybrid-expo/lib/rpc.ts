import { resolveApiBaseUrl } from '@/lib/api';

export type SolanaRpcNetwork = 'mainnet' | 'devnet';

function rpcUrl(path: string): string {
  return `${resolveApiBaseUrl()}${path}`;
}

/** Routes Solana JSON-RPC through the credential-owning API worker. */
export function resolveSolanaRpcUrl(network: SolanaRpcNetwork = 'mainnet'): string {
  return rpcUrl(network === 'devnet' ? '/rpc/solana-devnet' : '/rpc/solana');
}

/** Uses the API worker's WebSocket endpoint rather than web3.js's default port+1. */
export function resolveSolanaRpcWsUrl(network: SolanaRpcNetwork = 'mainnet'): string {
  const url = new URL(resolveSolanaRpcUrl(network));
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

/** Routes Polygon JSON-RPC through the credential-owning API worker. */
export function resolvePolygonRpcUrl(): string {
  return rpcUrl('/rpc/polygon');
}
