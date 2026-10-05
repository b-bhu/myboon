import type {
  MeteoraLimitDraft,
  MeteoraPhaseTwoAdapter,
  MeteoraPhaseTwoPreview,
  MeteoraPositionDraft,
  MeteoraPrepareContext,
} from './meteora.form';
import { walletBalanceClient } from '@/features/wallet/wallet.balance-client';
import { readMeteoraWalletBalances } from './meteora.wallet-balances';

/**
 * UI boundary for the product-level Meteora preview/build service.
 *
 * The Phase-2 screen intentionally knows nothing about SDK transactions, raw bin
 * parameters, generated signers, or wallet confirmation. The native execution
 * integration replaces these callbacks while web can keep the guarded fallback.
 */
export const meteoraPhaseTwoAdapter: MeteoraPhaseTwoAdapter = {
  async preparePosition(context, draft) {
    return unavailablePreview('position', context, draft);
  },
  async prepareLimitOrder(context, draft) {
    return unavailablePreview('limit', context, draft);
  },
  async execute() {
    throw new Error('Meteora execution is not available on this device yet');
  },
  async getWalletBalances(pool, walletAddress) {
    const balances = await readMeteoraWalletBalances(walletBalanceClient, walletAddress, pool);
    return { x: balances.x.display, y: balances.y.display };
  },
};

function unavailablePreview(
  kind: 'position' | 'limit',
  context: MeteoraPrepareContext,
  draft: MeteoraPositionDraft | MeteoraLimitDraft,
): MeteoraPhaseTwoPreview {
  const now = Date.now();
  const position = kind === 'position' ? draft as MeteoraPositionDraft : null;
  const limit = kind === 'limit' ? draft as MeteoraLimitDraft : null;
  return {
    id: `guarded-${kind}-${now}`,
    kind,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 30_000).toISOString(),
    currentPrice: context.pool.currentPrice ?? '0',
    requestedMinPrice: position?.requestedMinPrice || undefined,
    requestedMaxPrice: position?.requestedMaxPrice || undefined,
    executableMinPrice: position?.requestedMinPrice || undefined,
    executableMaxPrice: position?.requestedMaxPrice || undefined,
    requestedTargetPrice: limit?.requestedPrice || undefined,
    executableTargetPrice: limit?.requestedPrice || undefined,
    transactionCount: 1,
    costs: [],
    warnings: [{
      code: 'EXECUTION_ADAPTER_UNAVAILABLE',
      message: 'The executable Meteora preview is not available on this platform.',
      blocking: true,
    }],
    canExecute: false,
    walletAddress: context.walletAddress,
    network: 'mainnet-beta',
  };
}
