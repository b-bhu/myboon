import type { Hono } from 'hono'
import type { ApiKeyCreds } from '@polymarket/clob-client-v2'
import { deriveDepositWallet, TransactionType } from '@polymarket/builder-relayer-client'
import type { DepositWalletBatchRequest } from '@polymarket/builder-relayer-client'
import {
  CONTRACTS,
  DEPOSIT_WALLET_FACTORY,
  DEPOSIT_WALLET_IMPLEMENTATION,
  RELAYER_URL,
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
      const relay = getReadOnlyRelay()
      console.log('[clob] Using deposit wallet signatureType=3')
      const depositWalletAddress = deriveDepositWallet(eoaAddress, DEPOSIT_WALLET_FACTORY, DEPOSIT_WALLET_IMPLEMENTATION)
      console.log(`[clob] Deposit wallet address (derived): ${depositWalletAddress}`)

      try {
        const deployed = await relay.getDeployed(depositWalletAddress, TransactionType.WALLET)
        if (!deployed) {
          console.log(`[clob] Deploying deposit wallet for ${eoaAddress}...`)
          const createBody = JSON.stringify({ type: TransactionType.WALLET_CREATE, from: eoaAddress, to: DEPOSIT_WALLET_FACTORY })
          const headers = await relayerBuilderConfig.generateBuilderHeaders('POST', '/submit', createBody)
          const deployRes = await fetch(`${RELAYER_URL}/submit`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(headers ?? {}) },
            body: createBody,
          })
          const deployPayload = await deployRes.json().catch(() => ({}))
          if (!deployRes.ok) {
            throw new Error(deployPayload?.error || deployPayload?.message || `Deposit wallet deploy failed (${deployRes.status})`)
          }
          const deployResult = deployPayload?.transactionID
            ? await relay.pollUntilState(deployPayload.transactionID, ['STATE_MINED', 'STATE_CONFIRMED'], 'STATE_FAILED', 100)
            : undefined
          if (deployResult) console.log(`[clob] Deposit wallet deployed: tx=${deployResult.transactionHash}`)
          else console.warn('[clob] Deposit wallet deploy may have failed — continuing anyway')
        } else {
          console.log('[clob] Deposit wallet already deployed')
        }
      } catch (deployErr: any) {
        // The relayer reports an existing wallet with two different phrasings —
        // "already deployed" from the deploy poll, and "deposit wallet already
        // exists for signer 0x…" from /submit. Matching only the first meant the
        // second escaped as a failure, aborting `/auth` for any signer the
        // relayer already knows about and leaving the client with no session at
        // all. Both mean the same thing: the wallet is there, proceed.
        //
        // This is reachable even when the relayer's own /deployed check returns
        // false — it can hold a registration for an address that was never mined,
        // so "not deployed" and "already exists" are both true of the same
        // wallet. The session below only needs the derived address, which is
        // CREATE2-deterministic and correct either way.
        const deployMessage = String(deployErr?.message ?? '')
        if (/already (deployed|exists)/i.test(deployMessage)) {
          console.log(`[clob] Deposit wallet already present (caught): ${deployMessage}`)
        } else {
          throw deployErr
        }
      }

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
      const depositWalletAddress = deriveDepositWallet(
        eoaAddress,
        DEPOSIT_WALLET_FACTORY,
        DEPOSIT_WALLET_IMPLEMENTATION,
      ).toLowerCase()

      const relay = getReadOnlyRelay()
      const deployed = await relay.getDeployed(depositWalletAddress, TransactionType.WALLET)

      return c.json({
        hasAccount: !!deployed,
        polygonAddress: eoaAddress,
        walletMode: 'deposit_wallet' as const,
        tradingAddress: deployed ? depositWalletAddress : null,
        depositWalletAddress: deployed ? depositWalletAddress : null,
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
