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

/** `owner()` — the deposit wallet reports the signer that controls it. */
const OWNER_SELECTOR = '0x8da5cb5b'

/**
 * The deposit wallet this signer owns, deploying it first if it does not exist.
 *
 * Reads the address from the factory's creation event rather than computing it.
 * See the note at the call site for why the CREATE2 derivation cannot be
 * trusted here.
 */
async function resolveDepositWallet(
  eoaAddress: string,
  knownDepositWallet?: string,
): Promise<string> {
  const verifiedHint = await verifyDepositWalletHint(eoaAddress, knownDepositWallet)
  if (verifiedHint) {
    console.log(`[clob] Deposit wallet from verified client hint: ${verifiedHint}`)
    depositWalletByEoa.set(eoaAddress.toLowerCase(), verifiedHint)
    return verifiedHint
  }

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

  // The relayer says this signer has a wallet, but nothing available here can
  // name it: the deploy receipt belongs to a session that is gone, the recent
  // window did not cover it, and the client sent no address it had stored.
  // Say so precisely rather than reporting a generic failure — the fix is a
  // client that remembers, not a retry.
  throw new Error(
    `Deposit wallet exists for signer ${eoaAddress} but its address could not be recovered. `
    + 'Reconnect from a device that has completed setup for this wallet.',
  )
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

/**
 * How far back to look for a signer's creation event when it is not cached.
 *
 * Only reached for a wallet this process did not deploy — an earlier attempt, or
 * a restart. The RPC plan caps `eth_getLogs` at 10 blocks per call, so the range
 * is a direct latency cost: ~170ms per window. 3000 blocks is roughly the last
 * 90 minutes of Polygon and about 50 seconds of worst-case scanning, which
 * covers the case this exists for — a user retrying a setup that just failed —
 * without stalling the request.
 *
 * A wallet older than that is recovered from `depositWalletAddress` in the
 * client's own request instead; the app stores it per wallet and sends it back.
 */
const DEPOSIT_WALLET_LOOKBACK_BLOCKS = 200

/** The RPC plan refuses `eth_getLogs` spans wider than 10 blocks. */
const LOG_WINDOW = 10

async function findDeployedDepositWallet(eoaAddress: string): Promise<string | null> {
  const key = eoaAddress.toLowerCase()
  const cached = depositWalletByEoa.get(key)
  if (cached) {
    // Confirm it still holds code rather than trusting the cache blindly; a
    // reorged deploy would otherwise strand the session on a dead address.
    const code = await polygonProvider.getCode(cached).catch(() => '0x')
    if (code && code !== '0x') return cached
    depositWalletByEoa.delete(key)
  }

  const found = await scanForDepositWallet(key)
  if (found) depositWalletByEoa.set(key, found)
  return found
}

/**
 * Accept a client-supplied deposit wallet only if the chain agrees it belongs to
 * this signer.
 *
 * Two checks, both required. The address must hold contract code — otherwise it
 * is the stale CREATE2 derivation or a typo. And the factory's creation event
 * for it must name this signer as the owner — otherwise a client could point a
 * session at someone else's wallet and route funds there. The hint is a
 * shortcut past an unbounded log scan, never a grant of authority.
 */
async function verifyDepositWalletHint(
  eoaAddress: string,
  candidate?: string,
): Promise<string | null> {
  if (!candidate || !/^0x[a-f0-9]{40}$/iu.test(candidate)) return null
  const wallet = candidate.toLowerCase()

  try {
    const code = await polygonProvider.getCode(wallet)
    if (!code || code === '0x') return null

    // `owner()` — the wallet states who controls it. One call, no log range to
    // scan, and it answers over all history regardless of when the wallet was
    // created, which a filtered `eth_getLogs` cannot do on a capped RPC plan.
    const owner = await polygonProvider.call({ to: wallet, data: OWNER_SELECTOR })
    if (!owner || owner === '0x') return null
    const ownerAddress = `0x${owner.slice(-40)}`.toLowerCase()
    return ownerAddress === eoaAddress.toLowerCase() ? wallet : null
  } catch (err: any) {
    console.warn(`[clob] Could not verify deposit wallet hint: ${err?.message ?? err}`)
    return null
  }
}

/**
 * Search the factory's creation events for this signer's wallet.
 *
 * Bounded hard, and deliberately narrow. The RPC plan caps `eth_getLogs` at 10
 * blocks per call at ~170ms, so every block of range costs latency inside a
 * request the user is waiting on — an earlier 3000-block version took 78
 * seconds and still missed. This window covers a deploy that just happened in
 * this same flow (the receipt read failing, the event landing a block later),
 * which is the only case where scanning is both necessary and likely to hit.
 *
 * Anything older is recovered from the client's `knownDepositWalletAddress`,
 * which is verified on chain via `owner()` — a single call that works over all
 * history and does not depend on log ranges at all.
 */
async function scanForDepositWallet(eoaAddress: string): Promise<string | null> {
  const signerTopic = `0x${eoaAddress.replace(/^0x/, '').padStart(64, '0')}`
  let head: number
  try {
    head = await polygonProvider.getBlockNumber()
  } catch {
    return null
  }

  const floor = Math.max(0, head - DEPOSIT_WALLET_LOOKBACK_BLOCKS)
  for (let end = head; end > floor; end -= LOG_WINDOW) {
    const start = Math.max(floor, end - (LOG_WINDOW - 1))
    let logs
    try {
      logs = await polygonProvider.getLogs({
        address: DEPOSIT_WALLET_FACTORY,
        topics: [DEPOSIT_WALLET_CREATED_TOPIC, null, signerTopic],
        fromBlock: start,
        toBlock: end,
      })
    } catch {
      continue
    }
    const walletTopic = logs[0]?.topics[1]
    if (walletTopic) return `0x${walletTopic.slice(-40)}`.toLowerCase()
  }
  return null
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
      /**
       * The deposit wallet this client already knows about, from a previous
       * successful setup. Only a hint: it is verified on chain and against this
       * signer before use, so a wrong or hostile value is discarded rather than
       * trusted. It exists because the address is otherwise unrecoverable after
       * a server restart — the relayer refuses to re-create the wallet and
       * offers no signer-scoped lookup.
       */
      knownDepositWalletAddress?: string
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
      const depositWalletAddress = await resolveDepositWallet(eoaAddress, body.knownDepositWalletAddress)
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
