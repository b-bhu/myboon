import type { Hono } from 'hono'
import type { DepositWalletBatchRequest } from '@polymarket/builder-relayer-client'
import { encodeFunctionData, parseUnits } from 'viem'
import { CONTRACTS, ERC20_APPROVE_ABI } from '../contracts.js'
import { failedOperation, sessionExpired, withOperation } from '../operations.js'
import { getClient, sessions } from '../sessions.js'
import {
  getUsdceBalance,
  prepareTradingWalletCalls,
  relayerBuilderConfig,
  submitSignedDepositWalletBatch,
} from '../wallet.js'

export function registerFundRoutes(routes: Hono) {
  routes.get('/deposit/:polygonAddress', async (c) => {
    const polygonAddress = c.req.param('polygonAddress')
    const session = sessions.get(polygonAddress.toLowerCase())
    const depositAddress = session ? session.tradingAddress : polygonAddress
    try {
      const res = await fetch('https://bridge.polymarket.com/deposit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: depositAddress }),
      })
      if (!res.ok) {
        const text = await res.text()
        console.error(`[clob] Bridge API error ${res.status}: ${text}`)
        return c.json({ error: 'Bridge API error', detail: text }, 502)
      }
      const addresses = await res.json()
      console.log(`[clob] Deposit addresses fetched for trading wallet ${depositAddress}`)
      return c.json(addresses)
    } catch (err: any) {
      console.error('[clob] Deposit fetch failed:', err.message || err)
      return c.json({ error: 'Failed to fetch deposit addresses', detail: err.message }, 500)
    }
  })

  routes.get('/deposit-status/:depositAddress', async (c) => {
    const depositAddress = c.req.param('depositAddress')
    if (!depositAddress) return c.json({ error: 'Missing deposit address' }, 400)
    try {
      const res = await fetch(`https://bridge.polymarket.com/status/${encodeURIComponent(depositAddress)}`)
      if (!res.ok) {
        const text = await res.text()
        console.error(`[clob] Bridge status API error ${res.status}: ${text}`)
        return c.json({ error: 'Bridge status API error', detail: text }, 502)
      }
      return c.json(await res.json())
    } catch (err: any) {
      console.error('[clob] Deposit status fetch failed:', err.message || err)
      return c.json({ error: 'Failed to fetch deposit status', detail: err.message }, 500)
    }
  })

  routes.get('/balance/:polygonAddress', async (c) => {
    const polygonAddress = c.req.param('polygonAddress')
    const session = sessions.get(polygonAddress.toLowerCase())
    if (!session) return c.json(sessionExpired('predict_session'), 401)
    try {
      let wrapMeta: {
        attempted: boolean
        wrapped: boolean
        amount: number
        txHash: string | null
        error: string | null
        signatureRequired?: boolean
      } = { attempted: false, wrapped: false, amount: 0, txHash: null, error: null }

      const usdceBalance = await getUsdceBalance(session.tradingAddress).catch(() => 0n)
      if (usdceBalance > 0n) {
        wrapMeta = {
          attempted: false,
          wrapped: false,
          amount: Number(usdceBalance) / 1e6,
          txHash: null,
          error: null,
          signatureRequired: true,
        }
      }
      const result = await getClient(session).getBalanceAllowance({ asset_type: 'COLLATERAL' as any })
      const rawBalance = parseFloat(result.balance) || 0
      const rawAllowance = parseFloat(result.allowance) || 0
      const balance = rawBalance >= 1000 ? rawBalance / 1e6 : rawBalance
      const allowance = rawAllowance >= 1000 ? rawAllowance / 1e6 : rawAllowance
      console.log(`[clob] Balance for ${polygonAddress} (${session.walletMode}: ${session.tradingAddress}): raw=${rawBalance} -> ${balance} pUSD`)
      return c.json({ balance, allowance, wrap: wrapMeta, raw: result })
    } catch (err: any) {
      console.error('[clob] Balance fetch failed:', err.message || err)
      return c.json(failedOperation('predict_session', 'Failed to fetch balance', err.message), 500)
    }
  })

  routes.post('/wrap', async (c) => {
    let body: { polygonAddress?: string; batch?: DepositWalletBatchRequest }
    try {
      body = await c.req.json()
    } catch {
      return c.json(failedOperation('wrap', 'Bad request', null), 400)
    }
    const { polygonAddress } = body
    if (!polygonAddress) return c.json(failedOperation('wrap', 'Missing polygonAddress', null), 400)
    if (!relayerBuilderConfig) return c.json(failedOperation('wrap', 'Builder not configured', null), 500)
    const session = sessions.get(polygonAddress.toLowerCase())
    if (!session) return c.json(sessionExpired('wrap'), 401)

    try {
      if (body.batch) {
        const { relayInfo, execResult } = await submitSignedDepositWalletBatch(session, body.batch)
        const txHash = execResult?.transactionHash ?? relayInfo.transactionHash ?? null
        return c.json(withOperation({ txHash }, {
          ok: true,
          operation: 'wrap',
          status: txHash ? 'completed' : 'syncing',
          userMessage: 'Cash is ready for Predict.',
          identifiers: {
            txHash: txHash ?? undefined,
            tradingAddress: session.tradingAddress,
            depositWalletAddress: session.depositWalletAddress ?? undefined,
          },
          retry: txHash ? undefined : { canRetry: false, pollAfterMs: 10_000 },
        }))
      }

      const usdceBalance = await getUsdceBalance(session.tradingAddress)
      if (usdceBalance === 0n) return c.json(failedOperation('wrap', 'No USDC.e to wrap', null, 'failed'), 400)
      const tradingAddr = session.tradingAddress as `0x${string}`
      const onramp = CONTRACTS.COLLATERAL_ONRAMP as `0x${string}`
      const usdceContract = CONTRACTS.USDC_E as `0x${string}`
      const wrapTxs = [
        {
          to: usdceContract,
          data: encodeFunctionData({
            abi: ERC20_APPROVE_ABI,
            functionName: 'approve',
            args: [onramp, usdceBalance],
          }),
          value: '0',
        },
        {
          to: onramp,
          data: encodeFunctionData({
            abi: [{ name: 'wrap', type: 'function', inputs: [{ name: '_asset', type: 'address' }, { name: '_to', type: 'address' }, { name: '_amount', type: 'uint256' }], outputs: [] }] as const,
            functionName: 'wrap',
            args: [usdceContract, tradingAddr, usdceBalance],
          }),
          value: '0',
        },
      ]
      const { signatureRequest } = await prepareTradingWalletCalls(session, wrapTxs, 'wrap')
      return c.json(withOperation({ signatureRequest, amount: Number(usdceBalance) / 1e6 }, {
        ok: false,
        operation: 'wrap',
        status: 'needs_signature',
        userMessage: 'Sign once to prepare deposited cash for Predict.',
        retry: { canRetry: true },
      }))
    } catch (err: any) {
      console.error('[clob] Wrap failed:', err.message || err)
      return c.json(failedOperation('wrap', 'Wrap failed', err.message), 500)
    }
  })

  routes.post('/withdraw', async (c) => {
    let body: { polygonAddress?: string; amount?: number; solanaAddress?: string; batch?: DepositWalletBatchRequest }
    try {
      body = await c.req.json()
    } catch {
      return c.json(failedOperation('withdraw', 'Bad request', null), 400)
    }
    const { polygonAddress, amount, solanaAddress } = body
    if (!polygonAddress || !amount || !solanaAddress) {
      return c.json(failedOperation('withdraw', 'Missing required fields: polygonAddress, amount, solanaAddress', null), 400)
    }
    if (amount <= 0) return c.json(failedOperation('withdraw', 'Amount must be positive', null), 400)
    if (!relayerBuilderConfig) return c.json(failedOperation('withdraw', 'Builder not configured', null), 500)
    const session = sessions.get(polygonAddress.toLowerCase())
    if (!session) return c.json(sessionExpired('withdraw'), 401)

    try {
      if (body.batch) {
        const { relayInfo, execResult } = await submitSignedDepositWalletBatch(session, body.batch)
        const txHash = execResult?.transactionHash ?? relayInfo.transactionHash ?? null
        return c.json(withOperation({
          ok: true,
          amount,
          tradingAddress: session.tradingAddress,
          safeAddress: null,
          depositWalletAddress: session.depositWalletAddress ?? null,
          solanaAddress,
          txHash,
        }, {
          ok: true,
          operation: 'withdraw',
          status: 'bridging',
          userMessage: 'Withdraw submitted. Bridge confirmation can take a few minutes.',
          identifiers: {
            txHash: txHash ?? undefined,
            tradingAddress: session.tradingAddress,
            depositWalletAddress: session.depositWalletAddress ?? undefined,
          },
          retry: { canRetry: false, pollAfterMs: 15_000 },
        }))
      }

      const bridgeRes = await fetch('https://bridge.polymarket.com/withdraw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address: session.tradingAddress,
          toChainId: '1151111081099710',
          toTokenAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          recipientAddr: solanaAddress,
        }),
      })
      if (!bridgeRes.ok) {
        const text = await bridgeRes.text()
        console.error(`[clob] Bridge withdraw API error ${bridgeRes.status}: ${text}`)
        return c.json(failedOperation('withdraw', 'Bridge API error', text), 502)
      }
      const bridgeData = await bridgeRes.json() as Record<string, any>
      console.log('[clob] Bridge withdraw response:', JSON.stringify(bridgeData))
      const bridgeEvmAddress = bridgeData.address?.evm || bridgeData.depositAddress || bridgeData.address
      if (!bridgeEvmAddress || typeof bridgeEvmAddress !== 'string') {
        console.error('[clob] No EVM bridge address in response:', bridgeData)
        return c.json(failedOperation('withdraw', 'No bridge deposit address returned', null), 502)
      }
      // Exact decimal -> base units. `Math.floor(amount * 1e6)` is one unit
      // short for values binary floats cannot represent exactly (2.01 gives
      // 2009999), which both under-transfers and makes the client-side
      // calldata check in `predict.signing.ts` reject its own withdrawal.
      // Both sides must derive this identically.
      const amountRaw = parseUnits(amount.toFixed(6), 6)
      const transferTx = {
        to: CONTRACTS.PUSD,
        data: encodeFunctionData({
          abi: [{ name: 'transfer', type: 'function', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] }] as const,
          functionName: 'transfer',
          args: [bridgeEvmAddress as `0x${string}`, amountRaw],
        }),
        value: '0',
      }
      const { signatureRequest } = await prepareTradingWalletCalls(session, [transferTx], 'withdraw')
      console.log(`[clob] Withdraw ${amount}: signature required for pUSD -> bridge ${bridgeEvmAddress} -> Solana ${solanaAddress}`)
      return c.json(withOperation({
        amount,
        tradingAddress: session.tradingAddress,
        safeAddress: null,
        depositWalletAddress: session.depositWalletAddress ?? null,
        bridgeAddress: bridgeEvmAddress,
        solanaAddress,
        signatureRequest,
      }, {
        ok: false,
        operation: 'withdraw',
        status: 'needs_signature',
        userMessage: 'Sign once to submit this withdrawal.',
        identifiers: {
          bridgeAddress: bridgeEvmAddress,
          tradingAddress: session.tradingAddress,
          depositWalletAddress: session.depositWalletAddress ?? undefined,
        },
        retry: { canRetry: true },
      }))
    } catch (err: any) {
      console.error('[clob] Withdraw failed:', err.message || err)
      return c.json(failedOperation('withdraw', 'Withdraw failed', err.message), 500)
    }
  })
}
