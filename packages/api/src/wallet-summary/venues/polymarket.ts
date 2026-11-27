/**
 * Polymarket venue (#745): the summary's real polymarket slot (replaces the
 * #725 stub that answered `not_available_yet` for any address). Both reads
 * key on the `evm` query parameter, which the phone sends as the
 * already-resolved deposit (trading) wallet — the server never derives it
 * (#729: re-deriving with only one rule would point some accounts at an
 * empty wallet):
 * - cash: pUSD balanceOf on Polygon through config.polygonRpcUrl (the
 *   on-chain number; the signed CLOB "available" stays on the phone),
 * - positions: the public Data API v2 rows the phone's SDK reads.
 * `valueUsd` is the shared polymarketValueUsd — cash + open positions +
 * ready to collect — which leaves out open-order cost because the server
 * cannot see open orders. A data-api failure or rate limit makes this app
 * `unavailable` alone; a cash-RPC failure keeps the answer `ok` with null
 * cash and null value. No `evm` in the request: this person has no
 * Polymarket account served here — `not_connected` (#725).
 */
import type { AppSummary, PolymarketSummary } from '@myboon/shared/wallet-summary'
import { polymarketValueUsd } from '@myboon/shared/wallet-summary'
import { dataApiV2List } from '../../polymarket/read/data-api-v2.js'
import { fetchCashUsd } from '../../polymarket/read/cash-balance.js'
import { notConnectedApp, type WalletFetchContext, type WalletVenue } from '../service.js'

export interface PolymarketVenueOptions {
  /** Polygon JSON-RPC endpoint for the cash read; create-app passes config.polygonRpcUrl. */
  polygonRpcUrl?: string
  /** Injected fetch for tests; production uses global fetch. */
  fetch?: typeof fetch
}

/** The polymarket slot's venue shape: exactly the union member with that id. */
export type PolymarketVenue = Extract<WalletVenue, { id: 'polymarket' }>

export function createPolymarketVenue(options: PolymarketVenueOptions = {}): PolymarketVenue {
  const venueFetch = options.fetch ?? globalThis.fetch
  return {
    id: 'polymarket',
    async fetch({ evm, signal }: WalletFetchContext): Promise<AppSummary<PolymarketSummary>> {
      if (!evm) return notConnectedApp()
      try {
        // The cash read never throws (null is its failure answer), so a
        // rejection below is the data-api walk — this app's unavailable.
        const [cashUsd, held] = await Promise.all([
          fetchCashUsd(evm, { rpcUrl: options.polygonRpcUrl ?? '', fetch: venueFetch, signal }),
          dataApiV2List(evm, { fetch: venueFetch, signal }),
        ])
        return {
          status: 'ok',
          valueUsd: polymarketValueUsd({
            cashUsd,
            openPositionsValueUsd: held.openPositionsValueUsd,
            readyToCollectUsd: held.readyToCollectUsd,
          }),
          summary: {
            cashUsd,
            openPositionsValueUsd: held.openPositionsValueUsd,
            readyToCollectUsd: held.readyToCollectUsd,
            totalPnlUsd: held.totalPnlUsd,
            openPositionCount: held.openPositionCount,
          },
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { status: 'unavailable', valueUsd: null, summary: null, error: message }
      }
    },
  } satisfies PolymarketVenue
}
