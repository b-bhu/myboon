/**
 * The app registry for /wallet/summary (#725): one list entry per app.
 * Polymarket (#745) is the latest real venue; later issues add one file and
 * one list entry per app — nothing else changes.
 */
import { createPhoenixConfig, createPhoenixUpstream, type PhoenixUpstream } from '../../phoenix/index.js'
import { createPolymarketVenue } from './polymarket.js'
import type { WalletVenue } from '../service.js'
import { meteoraVenue } from './meteora.js'
import { pacificaVenue } from './pacifica.js'
import { createPhoenixVenue } from './phoenix.js'
import { spotVenue } from './spot.js'

export function walletVenues(
  options: { phoenix?: PhoenixUpstream; polygonRpcUrl?: string } = {},
): WalletVenue[] {
  return [
    // Polymarket: EVM-only (#745). The summary keys on the `evm` address,
    // already resolved to the deposit wallet (the server never derives it);
    // without it this person has no account there. Cash comes from the
    // Polygon RPC (the on-chain pUSD number), positions from Data API v2.
    createPolymarketVenue({ polygonRpcUrl: options.polygonRpcUrl }),
    // Phoenix perps account: Solana side (#744), read through the same
    // trader-state reader the Phoenix routes serve.
    createPhoenixVenue(options.phoenix ?? createPhoenixUpstream(createPhoenixConfig())),
    // Pacifica perps account: Solana side (#728), read from the same
    // three upstream calls the phone makes.
    pacificaVenue,
    // Meteora LP positions: Solana side (#726), read from the shared
    // MeteoraDataApiClient's open-portfolio answer.
    meteoraVenue,
    // Spot token holdings: the same Solana address /spot prices (#742).
    spotVenue,
  ]
}
