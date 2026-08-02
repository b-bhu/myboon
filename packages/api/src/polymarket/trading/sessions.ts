import { utils } from 'ethers'
import { ClobClient, SignatureTypeV2, Chain } from '@polymarket/clob-client-v2'
import type { ApiKeyCreds } from '@polymarket/clob-client-v2'
import { AUTH_PROOF_MAX_AGE_MS, BUILDER_CODE, CLOB_HOST } from './contracts.js'

export type WalletMode = 'deposit_wallet'

export interface ClobSession {
  creds: ApiKeyCreds
  eoaAddress: string
  walletMode: WalletMode
  tradingAddress: string
  depositWalletAddress?: string
  createdAt: number
}

export const sessions = new Map<string, ClobSession>()
const SESSION_TTL_MS = 24 * 60 * 60 * 1000

function predictSessionMessage(address: string, timestamp: number): string {
  return [
    'myboon:predict:server-session',
    `address:${address.toLowerCase()}`,
    `timestamp:${timestamp}`,
  ].join('\n')
}

export function verifyPredictSessionProof(ownerAddress: string, timestamp: number | undefined, signature: string | undefined): boolean {
  if (!timestamp || !Number.isFinite(timestamp) || !signature) return false
  if (Math.abs(Date.now() - timestamp) > AUTH_PROOF_MAX_AGE_MS) return false
  try {
    const recovered = utils.verifyMessage(predictSessionMessage(ownerAddress, timestamp), signature)
    return recovered.toLowerCase() === ownerAddress.toLowerCase()
  } catch {
    return false
  }
}

function cleanSessions() {
  const now = Date.now()
  for (const [addr, session] of sessions) {
    if (now - session.createdAt > SESSION_TTL_MS) sessions.delete(addr)
  }
}

// `unref` so this housekeeping timer never by itself keeps the process
// alive — it holds no work worth delaying shutdown (or a test run) for.
setInterval(cleanSessions, 60 * 60 * 1000).unref?.()

function addressOnlySigner(address: string) {
  return {
    getAddress: async () => address,
    _signTypedData: async () => {
      throw new Error('Server-side user signing is disabled')
    },
  }
}

export function getClient(session: ClobSession): ClobClient {
  return new ClobClient({
    host: CLOB_HOST,
    chain: Chain.POLYGON,
    signer: addressOnlySigner(session.eoaAddress),
    creds: session.creds,
    signatureType: SignatureTypeV2.POLY_1271,
    funderAddress: session.tradingAddress,
    builderConfig: { builderCode: BUILDER_CODE },
  })
}
