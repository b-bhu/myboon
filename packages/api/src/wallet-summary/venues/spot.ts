/**
 * Spot venue (#742): the summary's first real app. Its data is what
 * `GET /spot/:wallet/balances` serves, read through the shared
 * `fetchWalletBalances` (Rule: reuse, not copy — the Helius call and its
 * 15-second cache are unchanged). Helius already sorts the list by
 * `valueUsd`; the wire field `icon` there maps to `iconUrl` here.
 *
 * A summary request without a `solana` address has no Solana wallet to
 * summarise — the same "no account at that app" state Polymarket serves
 * for a missing `evm` address (#725): the wiki's Portfolio section says
 * an app the person has not connected shows nothing. An upstream failure
 * is left to the service: under `Promise.allSettled` a rejected venue
 * turns into that app's `unavailable` slot while its `[api]` log keeps
 * the detail.
 */
import type { AppSummary, SpotSummary } from '@myboon/shared/wallet-summary'
import { fetchWalletBalances } from '../../spot/balances.js'
import { notConnectedApp, type WalletFetchContext, type WalletVenue } from '../service.js'

export const spotVenue = {
  id: 'spot',
  /** @throws when the upstream balances call fails (the service maps it to `unavailable`). */
  async fetch({ solana }: WalletFetchContext): Promise<AppSummary<SpotSummary>> {
    if (!solana) return notConnectedApp()

    const balances = await fetchWalletBalances(solana)
    return {
      status: 'ok',
      valueUsd: balances.totalValueUsd,
      summary: {
        tokenCount: balances.tokens.length,
        tokens: balances.tokens.map((token) => ({
          mint: token.mint,
          symbol: token.symbol,
          iconUrl: token.icon,
          valueUsd: token.valueUsd,
        })),
      },
    }
  },
} satisfies WalletVenue
