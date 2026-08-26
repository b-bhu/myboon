import type { Hono } from 'hono'
import type { ApiKeyCreds } from '@polymarket/clob-client-v2'
import type { DepositWalletBatchRequest } from '@polymarket/builder-relayer-client'
import { CONTRACTS, polygonProvider } from '../contracts.js'
import {
  deriveBeaconDepositWalletAddress,
  isDeployedContractCode,
} from '../deposit-wallet.js'
import { failedOperation, sessionExpired, withOperation } from '../operations.js'
import { sessions, verifyPredictSessionProof, type ClobSession } from '../sessions.js'
import {
  buildComboApprovalTxs,
  prepareTradingWalletCalls,
  relayerBuilderConfig,
  submitSignedDepositWalletBatch,
  syncCollateralBalance,
} from '../wallet.js'

export interface SessionRouteDependencies {
  getCode(address: string): Promise<string>
}

const defaultDependencies: SessionRouteDependencies = {
  getCode: (address) => polygonProvider.getCode(address),
}

export function registerSessionRoutes(
  routes: Hono,
  dependencies: SessionRouteDependencies = defaultDependencies,
) {
  routes.post('/auth', async (c) => {
    let body: {
      polygonAddress?: string
      ownerAddress?: string
      creds?: ApiKeyCreds
      authTimestamp?: number
      authSignature?: string
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
    if (!verifyPredictSessionProof(ownerAddress, body.authTimestamp, body.authSignature)) {
      return c.json(failedOperation('predict_setup', 'Invalid Predict session proof', null), 401)
    }
    if (!creds?.key || !creds.secret || !creds.passphrase) {
      return c.json(failedOperation('predict_setup', 'Missing CLOB API credentials', null), 400)
    }
    if (!body.knownDepositWalletAddress || !/^0x[a-f0-9]{40}$/iu.test(body.knownDepositWalletAddress)) {
      return c.json(failedOperation(
        'predict_setup',
        'Missing or invalid knownDepositWalletAddress',
        null,
      ), 400)
    }

    const eoaAddress = ownerAddress
    const suppliedDepositWallet = body.knownDepositWalletAddress.toLowerCase()
    const expectedDepositWallet = deriveBeaconDepositWalletAddress(eoaAddress).toLowerCase()
    if (suppliedDepositWallet !== expectedDepositWallet) {
      console.warn(
        `[clob] Deposit wallet mismatch — EOA: ${eoaAddress}, expected: ${expectedDepositWallet}, supplied: ${suppliedDepositWallet}`,
      )
      return c.json(failedOperation(
        'predict_setup',
        'Deposit wallet does not match signer',
        'The supplied Deposit Wallet does not match the current wallet for this signer.',
      ), 400)
    }

    let deployed: boolean
    try {
      deployed = isDeployedContractCode(await dependencies.getCode(expectedDepositWallet))
    } catch (err: any) {
      console.error(
        `[clob] Deposit wallet deployment check failed — EOA: ${eoaAddress}, wallet: ${expectedDepositWallet}`,
        err?.message ?? err,
      )
      return c.json(failedOperation(
        'predict_setup',
        'Could not verify Deposit Wallet deployment',
        'The wallet deployment check failed. Try again in a moment.',
      ), 502)
    }

    console.log(
      `[clob] Deposit wallet validated — EOA: ${eoaAddress}, wallet: ${expectedDepositWallet}, deployed: ${deployed}`,
    )
    if (!deployed) {
      return c.json(failedOperation(
        'predict_setup',
        'Deposit Wallet setup incomplete',
        'The Deposit Wallet is not deployed. Complete wallet setup in the app and try again.',
      ), 409)
    }

    try {
      const sessionDraft: Omit<ClobSession, 'creds' | 'createdAt'> = {
        eoaAddress,
        walletMode: 'deposit_wallet',
        tradingAddress: expectedDepositWallet,
        depositWalletAddress: expectedDepositWallet,
      }
      const session: ClobSession = { ...sessionDraft, creds, createdAt: Date.now() }
      sessions.set(eoaAddress, session)
      console.log(`[clob] Session created — EOA: ${eoaAddress}, ${session.walletMode}: ${session.tradingAddress}`)

      return c.json(withOperation({
        polygonAddress: eoaAddress,
        walletMode: session.walletMode,
        tradingAddress: session.tradingAddress,
        safeAddress: null,
        depositWalletAddress: session.depositWalletAddress ?? null,
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
      console.error(`[clob] Session registration failed — EOA: ${eoaAddress}:`, err.message || err)
      return c.json(failedOperation('predict_setup', 'CLOB auth failed', err.message ?? null), 500)
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

  routes.get('/session/:polygonAddress', async (c) => {
    const polygonAddress = c.req.param('polygonAddress')
    if (!/^0x[a-f0-9]{40}$/iu.test(polygonAddress)) {
      return c.json({ error: 'Invalid polygonAddress' }, 400)
    }

    const eoaAddress = polygonAddress.toLowerCase()
    const session = sessions.get(eoaAddress)

    try {
      const depositWalletAddress = deriveBeaconDepositWalletAddress(eoaAddress).toLowerCase()
      const deployed = isDeployedContractCode(await dependencies.getCode(depositWalletAddress))

      return c.json({
        hasAccount: deployed,
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
