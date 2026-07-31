import type { Hono } from 'hono'
import type { ApiKeyCreds } from '@polymarket/clob-client-v2'
import { TransactionType } from '@polymarket/builder-relayer-client'
import type { DepositWalletBatchRequest } from '@polymarket/builder-relayer-client'
import {
  CONTRACTS,
  DEPOSIT_WALLET_FACTORY,
  RELAYER_URL,
  polygonProvider,
} from '../contracts.js'
import { failedOperation, sessionExpired, withOperation } from '../operations.js'
import { sessions, verifyPredictSessionProof, type ClobSession } from '../sessions.js'
import {
  buildApprovalTxs,
  buildComboApprovalTxs,
  getReadOnlyRelay,
  prepareTradingWalletCalls,
  relayerBuilderConfig,
  submitSignedDepositWalletBatch,
  syncCollateralBalance,
} from '../wallet.js'

/**
 * `DepositWalletCreated(address wallet, address owner, address signer)` — the
 * factory's creation event. `keccak256` of that signature; the wallet address is
 * the first indexed topic.
 */
const DEPOSIT_WALLET_CREATED_TOPIC =
  '0x7441de0ad639fe5d2bf1c22447715a0528b682385736bb40ae8dd92555eb8276'

/**
 * The deposit wallet this signer owns, deploying it first if it does not exist.
 *
 * Reads the address from the factory's creation event rather than computing it.
 * See the note at the call site for why the CREATE2 derivation cannot be
 * trusted here.
 */
async function resolveDepositWallet(eoaAddress: string): Promise<string> {
  const existing = await findDeployedDepositWallet(eoaAddress)
  if (existing) {
    console.log(`[clob] Deposit wallet already deployed: ${existing}`)
    return existing
  }

  if (!relayerBuilderConfig) throw new Error('Builder not configured')
  console.log(`[clob] Deploying deposit wallet for ${eoaAddress}...`)

  const createBody = JSON.stringify({
    type: TransactionType.WALLET_CREATE,
    from: eoaAddress,
    to: DEPOSIT_WALLET_FACTORY,
    metadata: 'Deploy Deposit Wallet',
  })
  const headers = await relayerBuilderConfig.generateBuilderHeaders('POST', '/submit', createBody)
  const deployRes = await fetch(`${RELAYER_URL}/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(headers ?? {}) },
    body: createBody,
  })
  const deployPayload: any = await deployRes.json().catch(() => ({}))

  if (!deployRes.ok) {
    // "already exists" means the relayer has this signer on file. That is not a
    // failure — the wallet is findable on-chain, so fall through to the lookup
    // below rather than aborting a setup that is further along than it looks.
    const message = String(deployPayload?.error ?? deployPayload?.message ?? '')
    if (!/already (deployed|exists)/i.test(message)) {
      throw new Error(message || `Deposit wallet deploy failed (${deployRes.status})`)
    }
    console.log(`[clob] Relayer reports wallet present: ${message}`)
  }

  const relay = getReadOnlyRelay()
  if (deployPayload?.transactionID) {
    const mined = await relay.pollUntilState(
      deployPayload.transactionID,
      ['STATE_MINED', 'STATE_CONFIRMED'],
      'STATE_FAILED',
      100,
    )
    const hash = (mined as any)?.transactionHash ?? deployPayload?.transactionHash
    if (hash) {
      // The node can lag the relayer's confirmation by a block, so the receipt
      // is not always available on the first read.
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const created = await depositWalletFromTx(hash)
        if (created) {
          console.log(`[clob] Deposit wallet deployed: ${created} (tx=${hash})`)
          rememberDepositWallet(eoaAddress, created)
          return created
        }
        await new Promise((resolve) => setTimeout(resolve, 2000))
      }
    }
  }

  // Deploy reported success but the address could not be read back — or the
  // relayer said the wallet already existed. Ask its history.
  const existingAfterDeploy = await findDeployedDepositWallet(eoaAddress)
  if (existingAfterDeploy) {
    console.log(`[clob] Deposit wallet resolved from relayer history: ${existingAfterDeploy}`)
    return existingAfterDeploy
  }

  throw new Error(`Deposit wallet was not found on chain for signer ${eoaAddress}`)
}

/**
 * The deposit wallet created by a given relayer transaction.
 *
 * Reads the factory's creation event out of the transaction receipt rather than
 * scanning history: `eth_getLogs` over the full chain is refused by rate-limited
 * RPC providers (Alchemy's free tier caps the range at 10 blocks), and the
 * receipt carries the same event with no range to scan.
 */
async function depositWalletFromTx(txHash: string): Promise<string | null> {
  const receipt = await polygonProvider.getTransactionReceipt(txHash)
  if (!receipt) return null
  const log = receipt.logs.find(
    (entry) =>
      entry.address.toLowerCase() === DEPOSIT_WALLET_FACTORY.toLowerCase()
      && entry.topics[0]?.toLowerCase() === DEPOSIT_WALLET_CREATED_TOPIC,
  )
  // topics[1] is the created wallet; topics[2..3] are owner and signer.
  const walletTopic = log?.topics[1]
  if (!walletTopic) return null
  return `0x${walletTopic.slice(-40)}`.toLowerCase()
}

/**
 * The signer's deposit wallet, if one has already been created for it.
 *
 * Cached per signer: the address is immutable once deployed, and the only other
 * way to recover it is the deploy receipt, which a later session no longer has.
 * Without this a returning user whose wallet exists would have no path back to
 * its address — the relayer refuses to re-create it, and the CREATE2 derivation
 * points somewhere the wallet is not.
 */
const depositWalletByEoa = new Map<string, string>()

async function findDeployedDepositWallet(eoaAddress: string): Promise<string | null> {
  const cached = depositWalletByEoa.get(eoaAddress.toLowerCase())
  if (!cached) return null
  // Confirm it still holds code rather than trusting the cache blindly; a
  // reorged deploy would otherwise strand the session on a dead address.
  const code = await polygonProvider.getCode(cached).catch(() => '0x')
  return code && code !== '0x' ? cached : null
}

function rememberDepositWallet(eoaAddress: string, depositWallet: string): void {
  depositWalletByEoa.set(eoaAddress.toLowerCase(), depositWallet.toLowerCase())
}

export function registerSessionRoutes(routes: Hono) {
  routes.post('/auth', async (c) => {
    let body: {
      polygonAddress?: string
      ownerAddress?: string
      creds?: ApiKeyCreds
      authTimestamp?: number
      authSignature?: string
    }
    try {
      body = await c.req.json()
    } catch {
      return c.json(failedOperation('predict_setup', 'Bad request', null), 400)
    }

    const ownerAddress = (body.ownerAddress ?? body.polygonAddress)?.toLowerCase()
    const { creds } = body
    if (!ownerAddress || !/^0x[a-f0-9]{40}$/iu.test(ownerAddress)) {
      return c.json(failedOperation('predict_setup', 'Missing or invalid polygonAddress', null), 400)
    }
    if (!creds?.key || !creds.secret || !creds.passphrase) {
      return c.json(failedOperation('predict_setup', 'Missing CLOB API credentials', null), 400)
    }
    if (!verifyPredictSessionProof(ownerAddress, body.authTimestamp, body.authSignature)) {
      return c.json(failedOperation('predict_setup', 'Invalid Predict session proof', null), 401)
    }
    if (!relayerBuilderConfig) {
      return c.json(failedOperation('predict_setup', 'Builder not configured — set POLYMARKET_BUILDER_* env vars', null), 500)
    }

    try {
      const eoaAddress = ownerAddress
      console.log('[clob] Using deposit wallet signatureType=3')

      // The deposit wallet address is *read*, never predicted.
      //
      // `deriveDepositWallet()` computes a CREATE2 address from the SDK's
      // DepositWalletImplementation constant, but the live factory clones the
      // Beacon at 0x7A18EDfe… (docs: /resources/contracts). The two disagree, so
      // the derived address is not where the wallet lands — verified on two
      // fresh signers, both of which deployed successfully to an address the
      // derivation did not predict. Every downstream step then targeted a
      // non-existent contract and the approval batch failed with "deposit wallet
      // … is not deployed", which is exactly what it was.
      //
      // Polymarket's own docs prescribe reading the address back rather than
      // computing it (/trading/wallets-auth: "The confirmed transaction includes
      // the new Deposit Wallet address as proxyAddress"). That field is empty in
      // practice for WALLET-CREATE, so the address comes from the factory's
      // creation event in the transaction receipt — the same value, one layer
      // down, and the only source that cannot drift from what was deployed.
      const depositWalletAddress = await resolveDepositWallet(eoaAddress)
      console.log(`[clob] Deposit wallet address (resolved): ${depositWalletAddress}`)

      const sessionDraft: Omit<ClobSession, 'creds' | 'createdAt'> = {
        eoaAddress: eoaAddress.toLowerCase(),
        walletMode: 'deposit_wallet',
        tradingAddress: depositWalletAddress.toLowerCase(),
        depositWalletAddress: depositWalletAddress.toLowerCase(),
      }
      const session: ClobSession = { ...sessionDraft, creds, createdAt: Date.now() }
      sessions.set(eoaAddress.toLowerCase(), session)
      const approval = await prepareTradingWalletCalls(session, buildApprovalTxs(), 'predict_setup')
      console.log(`[clob] Session created — EOA: ${eoaAddress}, ${session.walletMode}: ${session.tradingAddress}`)

      return c.json(withOperation({
        polygonAddress: eoaAddress,
        walletMode: session.walletMode,
        tradingAddress: session.tradingAddress,
        safeAddress: null,
        depositWalletAddress: session.depositWalletAddress ?? null,
        signatureRequest: approval.signatureRequest,
      }, {
        ok: true,
        operation: 'predict_setup',
        status: 'completed',
        userMessage: 'Predict wallet is ready.',
        identifiers: {
          tradingAddress: session.tradingAddress,
          depositWalletAddress: session.depositWalletAddress ?? undefined,
        },
      }))
    } catch (err: any) {
      console.error('[clob] Auth failed:', err.message || err)
      return c.json(failedOperation('predict_setup', 'CLOB auth failed', err.message), 500)
    }
  })

  routes.post('/wallet-batch', async (c) => {
    let body: { polygonAddress?: string; batch?: DepositWalletBatchRequest }
    try {
      body = await c.req.json()
    } catch {
      return c.json(failedOperation('predict_session', 'Bad request', null), 400)
    }
    const { polygonAddress, batch } = body
    if (!polygonAddress || !batch) return c.json(failedOperation('predict_session', 'Missing polygonAddress or batch', null), 400)
    const session = sessions.get(polygonAddress.toLowerCase())
    if (!session) return c.json(sessionExpired('predict_session'), 401)

    try {
      const { relayInfo, execResult } = await submitSignedDepositWalletBatch(session, batch)
      const txHash = execResult?.transactionHash ?? relayInfo.transactionHash ?? null
      try {
        await syncCollateralBalance(session)
      } catch (balanceErr: any) {
        console.warn(`[clob] Balance allowance sync failed after signed batch (non-fatal): ${balanceErr.message}`)
      }
      return c.json(withOperation({
        txHash,
        relayerTransactionId: relayInfo.transactionID ?? undefined,
        tradingAddress: session.tradingAddress,
        depositWalletAddress: session.depositWalletAddress ?? null,
      }, {
        ok: true,
        operation: 'predict_setup',
        status: txHash ? 'completed' : 'syncing',
        userMessage: txHash ? 'Predict wallet is ready.' : 'Predict wallet setup submitted.',
        identifiers: {
          txHash: txHash ?? undefined,
          relayerTransactionId: relayInfo.transactionID ?? undefined,
          tradingAddress: session.tradingAddress,
          depositWalletAddress: session.depositWalletAddress ?? undefined,
        },
        retry: txHash ? undefined : { canRetry: false, pollAfterMs: 10_000 },
      }))
    } catch (err: any) {
      console.error('[clob] Signed wallet batch failed:', err.message || err)
      return c.json(failedOperation('predict_setup', 'Wallet batch failed', err.message), 500)
    }
  })

  routes.post('/combo-approve', async (c) => {
    let body: { polygonAddress?: string }
    try {
      body = await c.req.json()
    } catch {
      return c.json(failedOperation('combo_approve', 'Bad request', null), 400)
    }
    const polygonAddress = body.polygonAddress?.toLowerCase()
    if (!polygonAddress || !/^0x[a-f0-9]{40}$/iu.test(polygonAddress)) {
      return c.json(failedOperation('combo_approve', 'Missing or invalid polygonAddress', null), 400)
    }
    if (!relayerBuilderConfig) {
      return c.json(failedOperation('combo_approve', 'Builder not configured — set POLYMARKET_BUILDER_* env vars', null), 500)
    }
    const session = sessions.get(polygonAddress)
    if (!session) return c.json(sessionExpired('combo_approve'), 401)

    try {
      const approval = await prepareTradingWalletCalls(session, buildComboApprovalTxs(), 'combo_approve')
      return c.json(withOperation({
        polygonAddress: session.eoaAddress,
        walletMode: session.walletMode,
        tradingAddress: session.tradingAddress,
        depositWalletAddress: session.depositWalletAddress ?? null,
        spender: CONTRACTS.COMBO_EXCHANGE_V3,
        signatureRequest: approval.signatureRequest,
      }, {
        ok: true,
        operation: 'combo_approve',
        status: 'needs_signature',
        userMessage: 'Combo approval needs your signature.',
        identifiers: {
          tradingAddress: session.tradingAddress,
          depositWalletAddress: session.depositWalletAddress ?? undefined,
        },
      }))
    } catch (err: any) {
      console.error('[clob] Combo approval prepare failed:', err.message || err)
      return c.json(failedOperation('combo_approve', 'Combo approval failed', err.message), 500)
    }
  })

  /**
   * Does this wallet already have a Polymarket account?
   *
   * The missing primitive. Every other route here *performs* setup; none could
   * report whether setup had already happened. The app therefore had no way to
   * learn its own account state except by running the full `/auth` flow and
   * having every step succeed — so a deposit wallet that already existed on
   * Polygon stayed invisible, and the UI kept offering to create it.
   *
   * Answered from the chain, not from `sessions`. The deposit wallet address is
   * CREATE2-derived from the EOA, so it is recomputed deterministically here and
   * checked for deployment on-chain. That makes the answer survive an API
   * restart, which the in-memory session map does not — the restart is exactly
   * when a memory-only answer would wrongly report "no account" for a user who
   * has one.
   *
   * `sessionLive` reports the separate, weaker fact that this process still
   * holds CLOB credentials. A deployed wallet with no live session means the
   * account exists and needs re-auth, not setup.
   */
  routes.get('/session/:polygonAddress', async (c) => {
    const polygonAddress = c.req.param('polygonAddress')
    if (!/^0x[a-f0-9]{40}$/iu.test(polygonAddress)) {
      return c.json({ error: 'Invalid polygonAddress' }, 400)
    }

    const eoaAddress = polygonAddress.toLowerCase()
    const session = sessions.get(eoaAddress)

    try {
      // Never derived — same reason as `/auth`. A live session already carries
      // the resolved address; otherwise fall back to what this process recorded
      // when it deployed the wallet.
      const depositWalletAddress =
        session?.depositWalletAddress ?? (await findDeployedDepositWallet(eoaAddress))

      return c.json({
        hasAccount: !!depositWalletAddress,
        polygonAddress: eoaAddress,
        walletMode: 'deposit_wallet' as const,
        tradingAddress: depositWalletAddress ?? null,
        depositWalletAddress: depositWalletAddress ?? null,
        sessionLive: !!session,
      })
    } catch (err: any) {
      // An RPC failure is not "no account" — reporting it as such would send a
      // set-up user back through setup. Say the state is unknown instead.
      console.error('[clob] Session lookup failed:', err.message || err)
      return c.json(
        { error: 'Could not determine account state', detail: err.message ?? null },
        502,
      )
    }
  })

  routes.delete('/session/:polygonAddress', async (c) => {
    const polygonAddress = c.req.param('polygonAddress')
    sessions.delete(polygonAddress.toLowerCase())
    return c.json({ ok: true })
  })
}
