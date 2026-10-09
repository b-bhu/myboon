import { Hono } from 'hono'
import type { WalletActivityRoutesOptions } from './types.js'

/** Routes mounted by the parent at /market. */
export function createWalletActivityRoutes(options: WalletActivityRoutesOptions): Hono {
  const routes = new Hono()

  routes.get('/wallet-activity', async (c) => {
    const chain = c.req.query('chain')
    if (chain !== undefined && chain !== 'solana') {
      return c.json({ error: 'Only chain=solana is supported', code: 'INVALID_CHAIN' }, 400)
    }

    const result = await options.service.getActivity()
    return c.json(result, result.status === 'unavailable' ? 503 : 200)
  })

  return routes
}

export type { WalletActivityRoutesOptions }
