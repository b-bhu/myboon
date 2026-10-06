export type RpcNetwork = 'solana' | 'solana-devnet' | 'polygon'

export type JsonRpcId = string | number | null

export type JsonRpcRequest = {
  jsonrpc: '2.0'
  id: JsonRpcId
  method: string
  params?: unknown
}

export type JsonRpcErrorBody = {
  jsonrpc: '2.0'
  id: JsonRpcId
  error: { code: number; message: string; data?: unknown }
}

const solanaMethods = new Set([
  'getAccountInfo', 'getBalance', 'getBlock', 'getBlockHeight', 'getBlockProduction',
  'getBlockTime', 'getBlocks', 'getBlocksWithLimit', 'getClusterNodes', 'getEpochInfo',
  'getEpochSchedule', 'getFeeForMessage', 'getFirstAvailableBlock', 'getGenesisHash',
  'getIdentity', 'getInflight', 'getLatestBlockhash', 'getLeaderSchedule', 'getMaxRetransmitSlot',
  'getMaxShredInsertSlot', 'getMinimumBalanceForRentExemption', 'getMinimumLedgerSlot', 'getMultipleAccounts', 'getParsedAccountInfo',
  'getParsedBlock', 'getParsedProgramAccounts', 'getParsedTokenAccountsByOwner',
  'getProgramAccounts', 'getRecentPerformanceSamples', 'getRecentPrioritizationFees',
  'getSignaturesForAddress', 'getSignatureStatuses', 'getSlot', 'getTokenAccountBalance',
  'getAddressLookupTable', 'getHealth', 'getStakeActivation', 'getSupply',
  'getTokenAccountsByOwner', 'getTokenLargestAccounts', 'getTokenSupply', 'getTransaction', 'getTransactionCount',
  'getVersion', 'getVoteAccounts', 'minimumLedgerSlot', 'simulateTransaction', 'sendTransaction',
  'accountSubscribe', 'accountUnsubscribe', 'logsSubscribe', 'logsUnsubscribe',
  'programSubscribe', 'programUnsubscribe', 'signatureSubscribe', 'signatureUnsubscribe',
  'slotSubscribe', 'slotUnsubscribe', 'slotsUpdatesSubscribe', 'slotsUpdatesUnsubscribe',
  'rootSubscribe', 'rootUnsubscribe', 'blockSubscribe', 'blockUnsubscribe', 'voteSubscribe',
  'voteUnsubscribe', 'blockProductionSubscribe', 'blockProductionUnsubscribe', 'ping',
])

const polygonMethods = new Set([
  'eth_chainId', 'net_version', 'eth_blockNumber', 'eth_getBalance', 'eth_getCode', 'eth_call',
  'eth_getLogs', 'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_estimateGas',
  'eth_gasPrice', 'eth_getBlockByNumber', 'eth_getBlockByHash', 'eth_getTransactionCount',
  'eth_feeHistory', 'eth_maxPriorityFeePerGas', 'eth_sendRawTransaction', 'web3_clientVersion',
])

export function allowedRpcMethod(network: RpcNetwork, method: string): boolean {
  return (network === 'polygon' ? polygonMethods : solanaMethods).has(method)
}

export function isSubscriptionMethod(method: string): boolean {
  return method.endsWith('Subscribe') || method.endsWith('Unsubscribe') || method === 'ping'
}

function validId(value: unknown): value is JsonRpcId {
  return value === null || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))
}

export function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcErrorBody {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } }
}

export function parseRpcPayload(value: unknown, network: RpcNetwork): JsonRpcRequest[] | JsonRpcErrorBody {
  const rows = Array.isArray(value) ? value : [value]
  if (rows.length === 0) return rpcError(null, -32600, 'Invalid Request')
  if (rows.length > 50) return rpcError(null, -32005, 'RPC batch limit exceeded')
  for (const row of rows) {
    if (!row || typeof row !== 'object') return rpcError(null, -32600, 'Invalid Request')
    const candidate = row as Record<string, unknown>
    if (candidate.jsonrpc !== '2.0' || typeof candidate.method !== 'string' || !validId(candidate.id)) {
      return rpcError(validId(candidate.id) ? candidate.id : null, -32600, 'Invalid Request')
    }
    if (!allowedRpcMethod(network, candidate.method)) {
      return rpcError(candidate.id, -32601, 'RPC method is not available through this proxy')
    }
  }
  return rows as JsonRpcRequest[]
}

export function sanitizeRpcSecrets(value: unknown, secrets: string[]): unknown {
  if (typeof value === 'string') {
    return secrets.reduce((text, secret) => secret ? text.split(secret).join('[redacted]') : text, value)
  }
  if (Array.isArray(value)) return value.map((entry) => sanitizeRpcSecrets(entry, secrets))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sanitizeRpcSecrets(entry, secrets)]))
  }
  return value
}

export function rpcEndpointSecrets(endpoint: string): string[] {
  const secrets = [endpoint]
  try {
    const parsed = new URL(endpoint)
    for (const value of parsed.searchParams.values()) if (value) secrets.push(value)
    if (parsed.username) secrets.push(decodeURIComponent(parsed.username))
    if (parsed.password) secrets.push(decodeURIComponent(parsed.password))
    // Alchemy-style endpoints carry the project key in a /v2/<key> path
    // segment rather than a query parameter. Restrict extraction to this
    // credential-bearing convention so ordinary provider paths are intact.
    const pathCredential = parsed.pathname.match(/\/v2\/([^/]+)/i)?.[1]
    if (pathCredential) {
      secrets.push(pathCredential)
      try { secrets.push(decodeURIComponent(pathCredential)) } catch { /* best effort */ }
    }
  } catch {
    // The endpoint is deployment configuration; ordinary URL validation is
    // performed by the upstream client. Keep sanitization best-effort here.
  }
  return [...new Set(secrets)]
}
