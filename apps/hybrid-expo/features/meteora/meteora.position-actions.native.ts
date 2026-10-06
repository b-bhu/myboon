import { MeteoraDataApiClient, MeteoraSdkClient, type MeteoraTransactionBundle } from '@myboon/shared/meteora';
import type { Connection, Transaction } from '@solana/web3.js';
import { METEORA_RPC_URL, METEORA_RPC_WS_URL } from './meteora.config';
import { PACIFIC_ENV } from '@/features/perps/pacific.config';
import { assertMeteoraWalletNetwork } from './meteora.network';
import {
  createMeteoraExecutionController,
  createMeteoraPendingStore,
  createNativeMeteoraPendingStorage,
  type MeteoraExecutionProgress,
  type MeteoraExecutionResult,
  type MeteoraExecutionStage,
} from './meteora.execution';
import type { MeteoraExecutionUpdate, MeteoraExecuteResult, MeteoraPrepareContext } from './meteora.form';
import type {
  MeteoraClaimPreview,
  MeteoraPositionActionsAdapter,
  MeteoraPositionSummary,
  MeteoraRemovePreview,
} from './meteora.position-actions';

const sdk = new MeteoraSdkClient({
  rpcUrl: METEORA_RPC_URL,
  rpcWsUrl: METEORA_RPC_WS_URL,
  network: 'mainnet-beta',
});
const approvalClient = new MeteoraDataApiClient();
const pendingStore = createMeteoraPendingStore(createNativeMeteoraPendingStorage());

export const meteoraPositionActionsAdapter: MeteoraPositionActionsAdapter = {
  async prepareClaim(context, position) {
    if (position.poolAddress !== context.pool.address) {
      throw new Error('The position pool does not match the open pool.');
    }
    return {
      positionAddress: position.positionAddress,
      poolAddress: position.poolAddress,
      transactionCount: 1,
      note: 'Claims all unclaimed fees and rewards on this position. This does not remove liquidity or close the position.',
    };
  },

  async executeClaim(context, preview, onProgress) {
    return runExecution(context, {
      intentId: `claim_${preview.positionAddress}_${Date.now()}`,
      action: 'claim',
      poolAddress: preview.poolAddress,
      resourceAddress: preview.positionAddress,
      build: () => sdk.buildClaim({
        walletAddress: context.walletAddress!,
        poolAddress: preview.poolAddress,
        positionAddress: preview.positionAddress,
      }),
      onProgress,
      completeMessage: 'Fees and rewards claimed.',
    });
  },

  async prepareRemove(context, position, removeBps, claimAndClose) {
    if (position.poolAddress !== context.pool.address) {
      throw new Error('The position pool does not match the open pool.');
    }
    if (!Number.isInteger(removeBps) || removeBps < 1 || removeBps > 10_000) {
      throw new Error('Removal percentage must be between 1 and 10000 basis points.');
    }
    return {
      positionAddress: position.positionAddress,
      poolAddress: position.poolAddress,
      removeBps,
      claimAndClose,
      transactionCount: 1,
    };
  },

  async executeRemove(context, preview, onProgress) {
    const approvedPool = await approvalClient.getPool(preview.poolAddress);
    if (!approvedPool.data.approvedByMeteora) {
      throw new Error('This pool is no longer approved with fresh Meteora data. Refresh before execution.');
    }
    const position = await sdk.getPosition(preview.poolAddress, preview.positionAddress);
    const lowerBinId = position.positionData.lowerBinId;
    const upperBinId = position.positionData.upperBinId;
    return runExecution(context, {
      intentId: `remove_${preview.positionAddress}_${Date.now()}`,
      action: preview.claimAndClose ? 'close_position' : 'remove_liquidity',
      poolAddress: preview.poolAddress,
      resourceAddress: preview.positionAddress,
      build: () => sdk.buildRemoveLiquidity({
        walletAddress: context.walletAddress!,
        poolAddress: preview.poolAddress,
        positionAddress: preview.positionAddress,
        fromBinId: lowerBinId,
        toBinId: upperBinId,
        removeBps: preview.removeBps,
        claimAndClose: preview.claimAndClose,
      }),
      onProgress,
      completeMessage: preview.claimAndClose
        ? 'Position closed and remaining assets returned.'
        : 'Liquidity removed.',
    });
  },

  async prepareAdd(context, position, amounts) {
    if (position.poolAddress !== context.pool.address) {
      throw new Error('The position pool does not match the open pool.');
    }
    return {
      positionAddress: position.positionAddress,
      poolAddress: position.poolAddress,
      // Meteora's position read API does not return the position's original
      // distribution strategy; beta defaults added liquidity to Spot.
      strategy: 'spot',
      tokenXAtomic: amounts.tokenXAtomic,
      tokenYAtomic: amounts.tokenYAtomic,
      transactionCount: 1,
    };
  },

  async executeAdd(context, preview, onProgress) {
    const approvedPool = await approvalClient.getPool(preview.poolAddress);
    if (!approvedPool.data.approvedByMeteora) {
      throw new Error('This pool is no longer approved with fresh Meteora data. Refresh before execution.');
    }
    const position = await sdk.getPosition(preview.poolAddress, preview.positionAddress);
    return runExecution(context, {
      intentId: `add_${preview.positionAddress}_${Date.now()}`,
      action: 'add_liquidity',
      poolAddress: preview.poolAddress,
      resourceAddress: preview.positionAddress,
      build: () => sdk.buildAddLiquidity({
        walletAddress: context.walletAddress!,
        poolAddress: preview.poolAddress,
        positionAddress: preview.positionAddress,
        tokenXAtomic: preview.tokenXAtomic,
        tokenYAtomic: preview.tokenYAtomic,
        minBinId: position.positionData.lowerBinId,
        maxBinId: position.positionData.upperBinId,
        strategy: preview.strategy,
      }),
      onProgress,
      completeMessage: 'Liquidity added.',
    });
  },
};

async function runExecution(
  context: MeteoraPrepareContext,
  options: {
    intentId: string;
    action: 'claim' | 'remove_liquidity' | 'close_position' | 'add_liquidity';
    poolAddress: string;
    resourceAddress: string;
    build: () => Promise<MeteoraTransactionBundle>;
    onProgress?: (update: MeteoraExecutionUpdate) => void;
    completeMessage: string;
  },
): Promise<MeteoraExecuteResult> {
  assertMeteoraWalletNetwork(PACIFIC_ENV === 'testnet' ? 'devnet' : 'mainnet-beta');
  if (!context.walletAddress) throw new Error('Connect a Solana wallet before continuing.');
  const wallet = {
    connected: context.wallet.connected,
    address: context.wallet.address,
    source: context.wallet.source === 'privy' ? 'privy' as const : 'mwa' as const,
    isPreparing: context.wallet.isPreparing,
    signAndSendTransaction: context.wallet.signAndSendTransaction
      ? async (transaction: Transaction) => normalizeWalletResult(
        await context.wallet.signAndSendTransaction?.(transaction),
      )
      : undefined,
  };
  const connection = isExecutionConnection(context.connection) ? context.connection : sdk.connection;
  const controller = createMeteoraExecutionController({
    connection,
    pendingStore,
    getWalletSnapshot: () => {
      const current = context.getWalletSnapshot?.() ?? context.wallet;
      return {
        connected: current.connected,
        address: current.address,
        source: current.source === 'privy' ? 'privy' : 'mwa',
        isPreparing: current.isPreparing,
        signAndSendTransaction: current.signAndSendTransaction
          ? async (transaction: Transaction) => normalizeWalletResult(
            await current.signAndSendTransaction?.(transaction),
          )
          : undefined,
      };
    },
  });

  const expiresAt = new Date(Date.now() + 30_000).toISOString();
  const result = await controller.execute({
    intentId: options.intentId,
    network: 'mainnet-beta',
    poolAddress: options.poolAddress,
    action: options.action,
    expiresAt,
    wallet,
    build: async () => {
      const bundle = await options.build();
      return {
        ...bundle,
        planId: bundle.plan?.planId,
        previewId: bundle.plan?.previewId ?? undefined,
        createdAt: bundle.plan?.createdAt,
        expiresAt: bundle.plan?.expiresAt ?? expiresAt,
        steps: undefined,
      };
    },
    reconcile: (reconcileContext) => sdk.isExecutionResourceVisible({
      action: reconcileContext.action,
      poolAddress: reconcileContext.poolAddress,
      resourceAddress: reconcileContext.resourceAddress,
    }),
    onProgress: (progress) => options.onProgress?.(executionUpdate(progress)),
  });

  return normalizeExecutionResult(result, options.completeMessage);
}

function normalizeWalletResult(value: unknown): string | { signature?: string | null } {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'signature' in value) {
    return value as { signature?: string | null };
  }
  throw new Error('The wallet did not return a transaction signature.');
}

function executionUpdate(progress: MeteoraExecutionProgress): MeteoraExecutionUpdate {
  return {
    state: operationState(progress.stage),
    message: progress.message,
    currentStep: progress.currentStep,
    totalSteps: progress.totalSteps,
    explorerUrl: progress.explorerUrls.at(-1),
  };
}

function operationState(stage: MeteoraExecutionStage): MeteoraExecutionUpdate['state'] {
  if (stage === 'building' || stage === 'validation') return 'building';
  if (stage === 'simulating') return 'simulating';
  if (stage === 'awaiting_wallet') return 'awaiting_wallet';
  if (stage === 'submitted') return 'submitted';
  if (stage === 'confirming') return 'confirming';
  if (stage === 'confirmed_syncing') return 'syncing';
  if (stage === 'complete') return 'success';
  if (stage === 'partially_complete') return 'partial';
  return 'error';
}

function normalizeExecutionResult(
  result: MeteoraExecutionResult,
  completeMessage: string,
): MeteoraExecuteResult {
  if (result.status === 'wallet_rejected') {
    return {
      state: 'cancelled',
      message: 'Wallet approval was cancelled. Your position is unchanged.',
      resourceAddress: result.resourceAddress ?? undefined,
    };
  }
  if (result.status === 'complete') {
    return {
      state: 'confirmed',
      message: completeMessage,
      signature: result.signatures.at(-1),
      explorerUrl: result.explorerUrls.at(-1),
      resourceAddress: result.resourceAddress ?? undefined,
    };
  }
  if (result.status === 'confirmed_syncing') {
    return {
      state: 'syncing',
      message: result.error?.message ?? 'Confirmed on-chain — syncing Meteora state.',
      signature: result.signatures.at(-1),
      explorerUrl: result.explorerUrls.at(-1),
      resourceAddress: result.resourceAddress ?? undefined,
    };
  }
  if (result.status === 'partially_complete') {
    return {
      state: 'partial',
      message: result.error?.message
        ?? 'An earlier transaction confirmed, but the remaining steps need recovery.',
      signature: result.signatures.at(-1),
      explorerUrl: result.explorerUrls.at(-1),
      resourceAddress: result.resourceAddress ?? undefined,
    };
  }
  if (result.status === 'confirmation_unknown') {
    return {
      state: 'submitted',
      message: result.error?.message
        ?? 'Transaction submitted; confirmation is still being checked.',
      signature: result.signatures.at(-1),
      explorerUrl: result.explorerUrls.at(-1),
      resourceAddress: result.resourceAddress ?? undefined,
    };
  }
  throw new Error(result.error?.message ?? 'Meteora execution did not complete.');
}

function isExecutionConnection(value: unknown): value is Connection {
  return !!value
    && typeof value === 'object'
    && 'getLatestBlockhash' in value
    && 'simulateTransaction' in value
    && 'confirmTransaction' in value;
}

export type { MeteoraPositionSummary, MeteoraClaimPreview, MeteoraRemovePreview };
