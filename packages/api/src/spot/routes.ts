import { Hono } from 'hono'
import { createSpotBalances, type SpotBalances } from './balances.js'

const SOLANA_ADDRESS_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

function isPlausibleSolanaAddress(value: string): boolean {
  return SOLANA_ADDRESS_PATTERN.test(value)
}

export interface SpotRoutesOptions {
  /** HELIUS_RPC_URL, read in bootstrap/config.ts; unset or empty means "not configured". */
  heliusRpcUrl?: string
  /** Share one balances cache with the wallet summary; built from `heliusRpcUrl` when omitted. */
  balances?: SpotBalances
}

export function createSpotRoutes(options: SpotRoutesOptions = {}): Hono {
  const balancesService = options.balances ?? createSpotBalances({ heliusRpcUrl: options.heliusRpcUrl })
  const routes = new Hono()

  // GET /spot/:wallet/balances — all token balances for the wallet, priced in USD.
  routes.get('/:wallet/balances', async (c) => {
    const wallet = c.req.param('wallet')
    if (!isPlausibleSolanaAddress(wallet)) {
      return c.json({ error: 'Invalid wallet address', code: 'INVALID_ADDRESS' }, 400)
    }

    try {
      return c.json(await balancesService.fetchWalletBalances(wallet))
    } catch (err) {
      console.error(`[api] Spot balances for ${wallet} unavailable:`, err instanceof Error ? err.message : err)
      return c.json({ error: 'Spot balances unavailable' }, 502)
    }
  })

  // GET /spot/:wallet/balances/:mint — balance for one specific mint (404 if not held).
  routes.get('/:wallet/balances/:mint', async (c) => {
    const wallet = c.req.param('wallet')
    const mint = c.req.param('mint')
    if (!isPlausibleSolanaAddress(wallet)) {
      return c.json({ error: 'Invalid wallet address', code: 'INVALID_ADDRESS' }, 400)
    }
    if (!isPlausibleSolanaAddress(mint)) {
      return c.json({ error: 'Invalid mint address', code: 'INVALID_ADDRESS' }, 400)
    }

    try {
      const balances = await balancesService.fetchWalletBalances(wallet)
      const token = balances.tokens.find((candidate) => candidate.mint === mint)
      if (!token) return c.json({ error: 'Mint not held by wallet' }, 404)
      return c.json(token)
    } catch (err) {
      console.error(`[api] Spot balance for ${wallet}/${mint} unavailable:`, err instanceof Error ? err.message : err)
      return c.json({ error: 'Spot balance unavailable' }, 502)
    }
  })

  return routes
}
