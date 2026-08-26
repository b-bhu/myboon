import { AssetType } from '@polymarket/clob-client-v2'
import { RelayClient, TransactionType } from '@polymarket/builder-relayer-client'
import type { DepositWalletBatchRequest, DepositWalletCall, Transaction } from '@polymarket/builder-relayer-client'
import { BuilderConfig as RelayerBuilderConfig } from '@polymarket/builder-signing-sdk'
import { encodeFunctionData, maxUint256 } from 'viem'
import {
  CHAIN_ID,
  CONTRACTS,
  DEPOSIT_WALLET_BATCH_DEADLINE_SECONDS,
  ERC20_APPROVE_ABI,
  polygonProvider,
  RELAYER_URL,
} from './contracts.js'
import { getClient, type ClobSession } from './sessions.js'
import type { PredictOperation } from '../lifecycle.js'

const builderKey = process.env.POLYMARKET_BUILDER_API_KEY
const builderSecret = process.env.POLYMARKET_BUILDER_SECRET
const builderPassphrase = process.env.POLYMARKET_BUILDER_PASSPHRASE

if (!builderKey || !builderSecret || !builderPassphrase) {
  console.warn('[clob] POLYMARKET_BUILDER_* env vars not set — gasless relay will fail')
}

export const relayerBuilderConfig = (builderKey && builderSecret && builderPassphrase)
  ? new RelayerBuilderConfig({
      localBuilderCreds: { key: builderKey, secret: builderSecret, passphrase: builderPassphrase },
    })
  : undefined

export async function getUsdceBalance(walletAddress: string): Promise<bigint> {
  const balanceData = encodeFunctionData({
    abi: [{ name: 'balanceOf', type: 'function', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] }] as const,
    functionName: 'balanceOf',
    args: [walletAddress as `0x${string}`],
  })
  const res = await polygonProvider.call({ to: CONTRACTS.USDC_E, data: balanceData })
  return BigInt(res)
}

export function buildComboApprovalTxs() {
  return [{
    to: CONTRACTS.PUSD,
    data: encodeFunctionData({
      abi: ERC20_APPROVE_ABI,
      functionName: 'approve',
      args: [CONTRACTS.COMBO_EXCHANGE_V3 as `0x${string}`, maxUint256],
    }),
    value: '0',
  }]
}

export function getReadOnlyRelay(): RelayClient {
  return new RelayClient(RELAYER_URL, CHAIN_ID)
}

function toDepositWalletCall(tx: Transaction): DepositWalletCall {
  return { target: tx.to, value: tx.value, data: tx.data }
}

export async function prepareTradingWalletCalls(
  session: ClobSession,
  txs: Transaction[],
  operation: PredictOperation | 'predict_setup',
) {
  if (!relayerBuilderConfig) throw new Error('Builder not configured')
  if (!session.depositWalletAddress) throw new Error('Missing deposit wallet address')
  const deadline = Math.floor(Date.now() / 1000 + DEPOSIT_WALLET_BATCH_DEADLINE_SECONDS).toString()
  const relay = getReadOnlyRelay()
  const noncePayload = await relay.getNonce(session.eoaAddress, TransactionType.WALLET)
  return {
    signatureRequest: {
      kind: 'deposit_wallet_batch' as const,
      operation,
      ownerAddress: session.eoaAddress,
      depositWalletAddress: session.depositWalletAddress,
      chainId: CHAIN_ID,
      nonce: noncePayload.nonce,
      deadline,
      calls: txs.map(toDepositWalletCall),
    },
  }
}

export async function submitSignedDepositWalletBatch(session: ClobSession, batch: DepositWalletBatchRequest) {
  if (!relayerBuilderConfig) throw new Error('Builder not configured')
  if (!session.depositWalletAddress) throw new Error('Missing deposit wallet address')
  if (batch.type !== TransactionType.WALLET) throw new Error('Invalid batch type')
  if (batch.from.toLowerCase() !== session.eoaAddress) throw new Error('Batch owner mismatch')
  if (batch.depositWalletParams.depositWallet.toLowerCase() !== session.depositWalletAddress) {
    throw new Error('Batch deposit wallet mismatch')
  }

  const body = JSON.stringify(batch)
  const headers = await relayerBuilderConfig.generateBuilderHeaders('POST', '/submit', body)
  const res = await fetch(`${RELAYER_URL}/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(headers ?? {}) },
    body,
  })
  const payload = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(payload?.error || payload?.message || `Relayer submit failed (${res.status})`)

  const relayInfo = {
    transactionID: payload?.transactionID ?? null,
    transactionHash: payload?.transactionHash ?? null,
    hash: payload?.hash ?? null,
    state: payload?.state ?? null,
  }
  const relay = getReadOnlyRelay()
  const execResult = relayInfo.transactionID
    ? await relay.pollUntilState(relayInfo.transactionID, ['STATE_MINED', 'STATE_CONFIRMED'], 'STATE_FAILED', 100)
    : undefined
  return { relay, relayInfo, execResult, response: payload }
}

export async function syncCollateralBalance(session: ClobSession) {
  const client = getClient(session)
  await client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL })
}
