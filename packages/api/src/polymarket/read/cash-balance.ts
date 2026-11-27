/**
 * Polymarket cash (#745): the pUSD (USDC.e collateral) balanceOf of the
 * already-resolved deposit (trading) wallet, read straight from Polygon.
 * Spike finding (#729): the on-chain balanceOf equals the app's CLOB cash
 * when no orders are open (37.595788 vs $37.60); with open orders the
 * signed "available" can be lower and the app keeps its own number — the
 * server deliberately serves the on-chain one, because open orders are not
 * served here.
 *
 * Nothing in packages/api read a token balance before this: plain fetch +
 * JSON-RPC `eth_call` with the balanceOf selector (0x70a08231) and the
 * address left-padded to 32 bytes, no ethers/viem in the call path, `fetch`
 * injectable for tests. Any failure (HTTP error, bad JSON, missing hex
 * result, aborted read) answers `null` cash — polymarketValueUsd then
 * returns a null value while the positions still serve.
 */
import { z } from 'zod'

/** Polymarket's pUSD collateral token on Polygon (6 decimals). */
export const PUSD_TOKEN_ADDRESS = '0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb'

/** Solidity selector for balanceOf(address). */
const BALANCE_OF_SELECTOR = '70a08231'
const PUSD_DECIMALS = 6

const ethCallResponseSchema = z.object({ result: z.string() })

export interface CashBalanceDeps {
  /** Polygon RPC endpoint (config.polygonRpcUrl in production wiring). */
  rpcUrl: string
  /** Injected fetch for tests; production uses global fetch. */
  fetch?: typeof fetch
  signal?: AbortSignal
}

/**
 * The deposit wallet's pUSD cash in USD, or null when the chain read does
 * not yield a numeric result. The address is passed as given — no
 * re-derivation, no case rewriting: the caller owns the resolution (#729),
 * and hex calldata is case-insensitive. Balances beyond Number precision
 * (~$9e9 at 6 decimals) may lose sub-cent accuracy.
 */
export async function fetchCashUsd(address: string, deps: CashBalanceDeps): Promise<number | null> {
  const data = `0x${BALANCE_OF_SELECTOR}${address.slice(2).padStart(64, '0')}`
  const doFetch = deps.fetch ?? globalThis.fetch
  try {
    const response = await doFetch(deps.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_call',
        params: [{ to: PUSD_TOKEN_ADDRESS, data }, 'latest'],
      }),
      signal: deps.signal,
    })
    if (!response.ok) return null
    const body = ethCallResponseSchema.parse(await response.json())
    if (!/^(0x[0-9a-fA-F]+|0x)$/.test(body.result)) return null
    if (body.result === '0x') return 0
    return Number(BigInt(body.result)) / 10 ** PUSD_DECIMALS
  } catch {
    return null
  }
}
