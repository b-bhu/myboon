/**
 * Meteora Manage context helpers (issue #917) — the pure inputs behind the
 * Wallet's Meteora Manage sheet (the sheet itself is issue #903).
 *
 * `toMeteoraPositionSummary` lifts a `WalletMeteoraPosition` (#867) into the
 * `MeteoraPositionSummary` the position-action adapter takes. The wallet side
 * carries no active bin id, so `activeBinId` stays null; the position's
 * out-of-range flag and the real bin ids carry the range story.
 *
 * `buildMeteoraPrepareContext` pairs a real `meteoraClient.getPool` result
 * (pool plus the freshness the load reported, from useMeteoraPool) with the
 * wallet mapping MeteoraPositionActionSheet.tsx uses — same
 * signAndSendTransaction wrapper, and the pool is passed through as given
 * with no fabricated fields (unlike the market sheet's portfolio-pool
 * stand-in).
 *
 * Type-only imports keep this file framework-free and runnable under plain
 * tsx.
 */

import type {
  MeteoraFreshness,
  MeteoraPoolDetail,
} from '@myboon/shared/meteora';
import type { WalletMeteoraPosition } from '@myboon/shared/wallet-summary';
import type { MeteoraPrepareContext } from '@/features/meteora/meteora.form';
import type { MeteoraPositionSummary } from '@/features/meteora/meteora.position-actions';
import type { useWallet } from '@/hooks/useWallet';

export function toMeteoraPositionSummary(position: WalletMeteoraPosition): MeteoraPositionSummary {
  return {
    positionAddress: position.address,
    poolAddress: position.poolAddress,
    lowerBinId: position.lowerBinId,
    upperBinId: position.upperBinId,
    activeBinId: null,
    isOutOfRange: position.outOfRange,
  };
}

export function buildMeteoraPrepareContext(
  pool: MeteoraPoolDetail,
  freshness: MeteoraFreshness,
  wallet: ReturnType<typeof useWallet>,
): MeteoraPrepareContext {
  return {
    pool,
    poolFreshness: freshness,
    walletAddress: wallet.address,
    connection: wallet.connection,
    wallet: {
      connected: wallet.connected,
      address: wallet.address,
      source: wallet.source,
      isPreparing: 'isPreparing' in wallet ? wallet.isPreparing : false,
      signAndSendTransaction: typeof wallet.signAndSendTransaction === 'function'
        ? (transaction: unknown) => (
          wallet.signAndSendTransaction as (value: unknown) => Promise<unknown>
        )(transaction)
        : null,
    },
  };
}
