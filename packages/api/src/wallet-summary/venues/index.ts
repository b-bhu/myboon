/**
 * The app registry for /wallet/summary (#725): one list entry per app.
 * Every app is a stub until its own issue lands (#714 checklist tracks
 * which) and answers `unavailable` / `not_available_yet`; Polymarket
 * answers `not_connected` when no `evm` address was sent. Later issues
 * add one file and one list entry per app — nothing else changes.
 */
import { notConnectedApp, unavailableApp, type WalletVenue } from '../service.js'
import { meteoraVenue } from './meteora.js'
import { phoenixVenue } from './phoenix.js'
import { spotVenue } from './spot.js'

export function walletVenues(): WalletVenue[] {
  return [
    // Polymarket: EVM-only. Its summary needs the `evm` address (#742 et al.
    // in the #714 checklist); without it this person has no account there.
    { id: 'polymarket', fetch: async ({ evm }) => (evm ? unavailableApp() : notConnectedApp()) },
    // Phoenix perps account: Solana side (#744), read through the same
    // trader-state reader the Phoenix routes serve.
    phoenixVenue,
    // Pacifica perps account: Solana side.
    { id: 'pacifica', fetch: async () => unavailableApp() },
    // Meteora LP positions: Solana side (#726), read from the shared
    // MeteoraDataApiClient's open-portfolio answer.
    meteoraVenue,
    // Spot token holdings: the same Solana address /spot prices (#742).
    spotVenue,
  ]
}
