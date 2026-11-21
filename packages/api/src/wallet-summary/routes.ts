/**
 * GET /wallet/summary (#725): one server call that returns every app's
 * summary, so the phone stops fetching from five places. Shape:
 * `?solana=<address>&evm=<address>` — both optional, at least one
 * required. The Solana regex is copied from src/spot.ts so both routes
 * accept exactly the same addresses; EVM is `0x` + 40 hex characters.
 */
import { Hono } from 'hono'
import type { WalletSummaryService } from './service.js'

// Same base58 pattern as /spot/:wallet/balances (src/spot.ts).
const SOLANA_ADDRESS_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
// EVM: 0x plus 40 hex characters.
const EVM_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/

export function createWalletSummaryRoutes(options: { service: WalletSummaryService }): Hono {
  const routes = new Hono()
  const { service } = options

  routes.get('/summary', async (c) => {
    const solana = c.req.query('solana') || null
    const evm = c.req.query('evm') || null
    if (!solana && !evm) {
      return c.json({ error: 'At least one of solana or evm is required', code: 'MISSING_ADDRESS' }, 400)
    }
    if (solana && !SOLANA_ADDRESS_PATTERN.test(solana)) {
      return c.json({ error: 'Invalid solana address', code: 'INVALID_ADDRESS' }, 400)
    }
    if (evm && !EVM_ADDRESS_PATTERN.test(evm)) {
      return c.json({ error: 'Invalid evm address', code: 'INVALID_ADDRESS' }, 400)
    }
    return c.json(await service.getSummary({ solana, evm }))
  })

  return routes
}
