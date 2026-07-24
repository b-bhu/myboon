import {
  MeteoraClientError,
  MeteoraDataApiClient,
  MeteoraSdkClient,
  assertPreviewUsable,
  resolveMeteoraPreset,
  snapRangeToPoolState,
  type MeteoraCreatePositionPreview,
  type MeteoraLimitOrderPreview,
  type MeteoraRangeRequest,
  type MeteoraTransactionBundle,
  type MeteoraZapInPreview,
} from '@myboon/shared/meteora';
import { PublicKey, type Connection, type Transaction } from '@solana/web3.js';
import {
  METEORA_RANGE_PRESETS,
  METEORA_RPC_URL,
  METEORA_ZAP_EXECUTION_ENABLED,
} from './meteora.config';
import {
  createMeteoraExecutionController,
  createMeteoraPendingStore,
  createWebMeteoraPendingStorage,
  type MeteoraExecutionResult,
  type MeteoraExecutionProgress,
  type MeteoraExecutionStage,
} from './meteora.execution.web';
import type {
  MeteoraExecutionUpdate,
  MeteoraPhaseTwoAdapter,
  MeteoraPhaseTwoPreview,
  MeteoraPositionDraft,
  MeteoraPrepareContext,
} from './meteora.form';

/**
 * Web execution adapter.
 *
 * This is a local-testing convenience, not a shipped product surface — myBoon
 * only ships Meteora execution on mobile (Mobile Wallet Adapter). It mirrors
 * `meteora.form-execution.native.ts` exactly, swapping in the connected
 * browser wallet (Phantom/Solflare/etc. via the shared `useWallet` hook and
 * `@solana/wallet-adapter-react`) in place of Mobile Wallet Adapter, and
 * browser-storage-backed pending-execution recovery in place of AsyncStorage.
 */

type SharedPreview =
  | MeteoraCreatePositionPreview
  | MeteoraLimitOrderPreview
  | MeteoraZapInPreview;

const sdk = new MeteoraSdkClient({
  rpcUrl: METEORA_RPC_URL,
  network: 'mainnet-beta',
});
const approvalClient = new MeteoraDataApiClient();
const pendingStore = createMeteoraPendingStore(createWebMeteoraPendingStorage());

export const meteoraPhaseTwoAdapter: MeteoraPhaseTwoAdapter = {
  async getDefaultRange(pool) {
    const state = await sdk.getExecutionPoolState(pool.address);
    const range = snapRangeToPoolState(state, {
      kind: 'meteora_preset',
      binDelta: 34,
      label: '69-bin default',
    });
    return {
      requestedMinPrice: range.executableMinPrice,
      requestedMaxPrice: range.executableMaxPrice,
      binCount: range.binCount,
    };
  },

  getCapabilities(poolAddress) {
    return sdk.getExecutionCapabilities(poolAddress);
  },

  async getWalletBalances(pool, walletAddress) {
    try {
      const owner = new PublicKey(walletAddress);
      const [x, y] = await Promise.all([
        readTokenBalance(sdk.connection, owner, pool.tokenX.address),
        readTokenBalance(sdk.connection, owner, pool.tokenY.address),
      ]);
      return { x: x.display, y: y.display };
    } catch {
      // A genuine RPC failure (rate limit, bad config, etc.) — the caller
      // shows "Unavailable" rather than hanging on "Checking…" forever.
      return { x: null, y: null };
    }
  },

  async recoverPending(context, onProgress) {
    if (!context.walletAddress) return null;
    const pending = (await pendingStore.list()).find((candidate) => (
      candidate.walletAddress === context.walletAddress
      && candidate.network === 'mainnet-beta'
      && candidate.poolAddress === context.pool.address
      && candidate.status !== 'onchain_failed'
    ));
    if (!pending) return null;
    const connection = isExecutionConnection(context.connection)
      ? context.connection
      : sdk.connection;
    const controller = createMeteoraExecutionController({
      connection,
      pendingStore,
      getWalletSnapshot: () => {
        const current = context.getWalletSnapshot?.() ?? context.wallet;
        return {
          connected: current.connected,
          address: current.address,
          source: 'web',
          isPreparing: current.isPreparing,
          signAndSendTransaction: undefined,
        };
      },
    });
    const result = await controller.recover(pending, {
      walletAddress: context.walletAddress,
      network: 'mainnet-beta',
      reconcile: (reconcileContext) => sdk.isExecutionResourceVisible({
        action: reconcileContext.action,
        poolAddress: reconcileContext.poolAddress,
        resourceAddress: reconcileContext.resourceAddress,
      }),
      onProgress: (progress) => onProgress?.(executionUpdate(progress)),
    });
    return normalizeExecutionResult(result);
  },

  async preparePosition(context, draft) {
    const range = rangeRequest(draft);
    let sourcePreview: SharedPreview;

    if (draft.fundingMode === 'single') {
      sourcePreview = await sdk.previewZapIn({
        poolAddress: context.pool.address,
        strategy: draft.strategy,
        range,
        inputToken: draft.singleTokenSide,
        amount: draft.singleTokenSide === 'x' ? draft.amountX : draft.amountY,
      });
    } else if (draft.autoFill) {
      const hasX = draft.amountX.length > 0;
      const hasY = draft.amountY.length > 0;
      if (hasX === hasY) {
        throw new MeteoraClientError(
          'INVALID_DEPOSIT_COMBINATION',
          'For Auto-Fill, enter one pool-token amount and leave the other amount empty',
        );
      }
      const quote = await sdk.quoteAutoFill({
        poolAddress: context.pool.address,
        strategy: draft.strategy,
        range,
        inputToken: hasX ? 'x' : 'y',
        amount: hasX ? draft.amountX : draft.amountY,
      });
      sourcePreview = await sdk.previewCreatePosition({
        poolAddress: context.pool.address,
        strategy: draft.strategy,
        range,
        depositMode: 'two_token',
        tokenXAmount: quote.tokenXAmount,
        tokenYAmount: quote.tokenYAmount,
      });
    } else {
      sourcePreview = await sdk.previewCreatePosition({
        poolAddress: context.pool.address,
        strategy: draft.strategy,
        range,
        depositMode: 'two_token',
        tokenXAmount: draft.amountX,
        tokenYAmount: draft.amountY,
      });
    }

    return normalizePreview(context, sourcePreview);
  },

  async prepareLimitOrder(context, draft) {
    const sourcePreview = await sdk.previewLimitOrder({
      poolAddress: context.pool.address,
      side: draft.side,
      amount: draft.amount,
      price: draft.requestedPrice,
    });
    return normalizePreview(context, sourcePreview);
  },

  async execute(context, preview, onProgress) {
    const sourcePreview = preview.sourcePreview as SharedPreview | undefined;
    if (!sourcePreview) throw new Error('The executable Meteora preview is missing. Refresh it.');
    if (preview.network !== 'mainnet-beta' || preview.walletAddress !== context.walletAddress) {
      throw new Error('The wallet or network changed. Refresh the executable preview.');
    }
    approvalClient.clearCache();
    const approvedPool = await approvalClient.getPool(context.pool.address);
    if (!approvedPool.data.approvedByMeteora || approvedPool.freshness.state === 'stale') {
      throw new Error('This pool is no longer approved with fresh Meteora data. Refresh before execution.');
    }
    assertPreviewUsable(sourcePreview);

    const wallet = {
      connected: context.wallet.connected,
      address: context.wallet.address,
      source: 'web' as const,
      isPreparing: context.wallet.isPreparing,
      signAndSendTransaction: context.wallet.signAndSendTransaction
        ? async (transaction: Transaction) => normalizeWalletResult(
          await context.wallet.signAndSendTransaction?.(transaction),
        )
        : undefined,
    };
    const connection = isExecutionConnection(context.connection)
      ? context.connection
      : sdk.connection;
    const controller = createMeteoraExecutionController({
      connection,
      pendingStore,
      getWalletSnapshot: () => {
        const current = context.getWalletSnapshot?.() ?? context.wallet;
        return {
          connected: current.connected,
          address: current.address,
          source: 'web',
          isPreparing: current.isPreparing,
          signAndSendTransaction: current.signAndSendTransaction
            ? async (transaction: Transaction) => normalizeWalletResult(
              await current.signAndSendTransaction?.(transaction),
            )
            : undefined,
        };
      },
    });
    const action = actionFor(sourcePreview);
    const result = await controller.execute({
      intentId: sourcePreview.previewId,
      network: 'mainnet-beta',
      poolAddress: sourcePreview.poolState.poolAddress,
      action,
      expiresAt: sourcePreview.expiresAt,
      wallet,
      build: async () => executionBundle(await buildFromPreview(
        sourcePreview,
        context.walletAddress,
      )),
      validate: () => assertPreviewUsable(sourcePreview),
      reconcile: (reconcileContext) => sdk.isExecutionResourceVisible({
        action: reconcileContext.action,
        poolAddress: reconcileContext.poolAddress,
        resourceAddress: reconcileContext.resourceAddress,
      }),
      onProgress: (progress) => onProgress?.(executionUpdate(progress)),
    });

    return normalizeExecutionResult(
      result,
      sourcePreview.kind === 'limit_order'
        ? 'Limit order confirmed and visible.'
        : 'Position confirmed and visible.',
    );
  },
};

function rangeRequest(draft: MeteoraPositionDraft): MeteoraRangeRequest {
  if (draft.preset === 'manual') {
    return {
      kind: 'manual',
      minPrice: draft.requestedMinPrice,
      maxPrice: draft.requestedMaxPrice,
    };
  }
  const preset = METEORA_RANGE_PRESETS.find((candidate) => candidate.id === draft.preset);
  if (!preset) throw new Error(`${draft.preset} range is unavailable`);
  return resolveMeteoraPreset(preset);
}

async function normalizePreview(
  context: MeteoraPrepareContext,
  source: SharedPreview,
): Promise<MeteoraPhaseTwoPreview> {
  const balances = context.walletAddress
    ? await readBalances(context.walletAddress, source)
    : { x: null, y: null };
  const warnings: MeteoraPhaseTwoPreview['warnings'] = [];
  const required = requiredAtomic(source);
  const displayed = displayedAtomic(source, required);

  if (balances.x !== null && BigInt(required.x) > balances.x.atomic) {
    warnings.push({
      code: 'INSUFFICIENT_TOKEN_BALANCE',
      message: `Insufficient ${context.pool.tokenX.symbol} balance.`,
      blocking: true,
    });
  }
  if (balances.y !== null && BigInt(required.y) > balances.y.atomic) {
    warnings.push({
      code: 'INSUFFICIENT_TOKEN_BALANCE',
      message: `Insufficient ${context.pool.tokenY.symbol} balance.`,
      blocking: true,
    });
  }
  if (source.kind === 'zap_in' && !source.estimate) {
    warnings.push({
      code: 'ZAP_UNAVAILABLE',
      message: 'Meteora did not return a usable Zap quote. Use both pool tokens instead.',
      blocking: true,
    });
  }
  if (!context.pool.approvedByMeteora) {
    warnings.push({
      code: 'POOL_NOT_SUPPORTED',
      message: 'This pool is not currently approved for myBoon execution.',
      blocking: true,
    });
  }
  if (source.kind === 'zap_in' && !METEORA_ZAP_EXECUTION_ENABLED) {
    warnings.push({
      code: 'ZAP_RECOVERY_UNAVAILABLE',
      message: 'One-token execution is temporarily gated until an interrupted multi-step Zap can resume without replaying a confirmed swap. Use both pool tokens for beta execution.',
      blocking: true,
    });
  }

  return {
    id: source.previewId,
    kind: source.kind === 'limit_order' ? 'limit' : 'position',
    createdAt: source.createdAt,
    expiresAt: source.expiresAt,
    currentPrice: source.poolState.activePrice,
    activeBinId: source.poolState.activeBinId,
    ...(source.kind === 'limit_order'
      ? {
          requestedTargetPrice: source.requestedPrice,
          executableTargetPrice: source.executablePrice,
          targetBinId: source.binId,
          distanceFromCurrentPct: percentDistance(
            source.executablePrice,
            source.poolState.activePrice,
          ),
          estimatedOutput: source.estimatedFullFillOutput,
        }
      : {
          requestedMinPrice: source.range.requestedMinPrice,
          requestedMaxPrice: source.range.requestedMaxPrice,
          executableMinPrice: source.range.executableMinPrice,
          executableMaxPrice: source.range.executableMaxPrice,
          minBinId: source.range.minBinId,
          maxBinId: source.range.maxBinId,
          binCount: source.range.binCount,
        }),
    requiredAmountX: formatAtomic(displayed.x, source.poolState.tokenX.decimals),
    requiredAmountY: formatAtomic(displayed.y, source.poolState.tokenY.decimals),
    ...(source.kind === 'zap_in' && source.estimate
      ? {
          zapRoute: source.estimate.route === 'dlmm'
            ? 'Meteora DLMM'
            : source.estimate.route === 'jupiter'
              ? 'Jupiter'
              : 'No swap required',
          zapSwapAmount: formatAtomic(
            source.estimate.swapAmountAtomic,
            source.inputToken === 'x'
              ? source.poolState.tokenX.decimals
              : source.poolState.tokenY.decimals,
          ),
          zapExpectedOutput: formatAtomic(
            source.estimate.expectedOutputAtomic,
            source.inputToken === 'x'
              ? source.poolState.tokenY.decimals
              : source.poolState.tokenX.decimals,
          ),
          zapMinimumOutput: formatAtomic(
            source.estimate.minimumOutputAtomic,
            source.inputToken === 'x'
              ? source.poolState.tokenY.decimals
              : source.poolState.tokenX.decimals,
          ),
          zapPriceImpactPct: `${source.estimate.priceImpactPct}%`,
          zapSlippageBps: source.defaults.swapSlippageBps,
        }
      : {}),
    spendableBalanceX: balances.x?.display,
    spendableBalanceY: balances.y?.display,
    transactionCount: source.transactionPlan.expectedSteps.length,
    costs: [
      {
        label: 'Network fee and account rent',
        value: 'Validated before wallet approval',
      },
    ],
    warnings,
    canExecute: warnings.every((warning) => !warning.blocking),
    walletAddress: context.walletAddress,
    network: 'mainnet-beta',
    sourcePreview: source,
  };
}

function displayedAtomic(
  source: SharedPreview,
  required: { x: string; y: string },
): { x: string; y: string } {
  if (source.kind !== 'zap_in' || !source.estimate) return required;
  return {
    x: source.estimate.postSwapXAtomic,
    y: source.estimate.postSwapYAtomic,
  };
}

function requiredAtomic(source: SharedPreview): { x: string; y: string } {
  if (source.kind === 'create_position') {
    return {
      x: source.amounts.tokenXAtomic,
      y: source.amounts.tokenYAtomic,
    };
  }
  if (source.kind === 'zap_in') {
    return source.inputToken === 'x'
      ? { x: source.inputTokenAtomic, y: '0' }
      : { x: '0', y: source.inputTokenAtomic };
  }
  return source.inputToken === 'x'
    ? { x: source.inputTokenAtomic, y: '0' }
    : { x: '0', y: source.inputTokenAtomic };
}

async function readBalances(walletAddress: string, source: SharedPreview) {
  const owner = new PublicKey(walletAddress);
  const [x, y] = await Promise.all([
    readTokenBalance(sdk.connection, owner, source.poolState.tokenX.address),
    readTokenBalance(sdk.connection, owner, source.poolState.tokenY.address),
  ]);
  return { x, y };
}

async function readTokenBalance(connection: Connection, owner: PublicKey, mintAddress: string) {
  const response = await connection.getParsedTokenAccountsByOwner(
    owner,
    { mint: new PublicKey(mintAddress) },
    'confirmed',
  );
  let atomic = 0n;
  let decimals = 0;
  for (const account of response.value) {
    const tokenAmount = account.account.data.parsed.info.tokenAmount as {
      amount: string;
      decimals: number;
    };
    atomic += BigInt(tokenAmount.amount);
    decimals = tokenAmount.decimals;
  }
  return { atomic, display: formatAtomic(atomic.toString(), decimals) };
}

function formatAtomic(value: string, decimals: number): string {
  const padded = value.padStart(decimals + 1, '0');
  const whole = padded.slice(0, -decimals) || '0';
  if (decimals === 0) return whole;
  const fraction = padded.slice(-decimals).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

function percentDistance(value: string, current: string): string {
  const targetNumber = Number(value);
  const currentNumber = Number(current);
  if (!Number.isFinite(targetNumber) || !Number.isFinite(currentNumber) || currentNumber <= 0) {
    return '—';
  }
  const percent = ((targetNumber - currentNumber) / currentNumber) * 100;
  return `${percent >= 0 ? '+' : ''}${percent.toFixed(2)}%`;
}

async function buildFromPreview(source: SharedPreview, walletAddress: string | null) {
  if (!walletAddress) throw new Error('Connect a Solana wallet before building.');
  if (source.kind === 'create_position') {
    return sdk.buildCreatePositionFromPreview({ walletAddress, preview: source });
  }
  if (source.kind === 'limit_order') {
    return sdk.buildLimitOrderFromPreview({ walletAddress, preview: source });
  }
  return sdk.buildZapInFromPreview({ walletAddress, preview: source });
}

function executionBundle(bundle: MeteoraTransactionBundle) {
  return {
    ...bundle,
    planId: bundle.plan?.planId,
    previewId: bundle.plan?.previewId ?? undefined,
    createdAt: bundle.plan?.createdAt,
    expiresAt: bundle.plan?.expiresAt ?? undefined,
    steps: bundle.plan?.steps,
  };
}

function actionFor(source: SharedPreview) {
  if (source.kind === 'create_position') return 'create_position';
  if (source.kind === 'limit_order') return 'place_limit_order';
  return 'zap_in';
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
  completeMessage = 'Meteora transaction confirmed and visible.',
) {
  if (result.status === 'wallet_rejected') {
    return {
      state: 'cancelled' as const,
      message: 'Wallet approval was cancelled. Your inputs are unchanged.',
      signature: undefined,
      explorerUrl: undefined,
      resourceAddress: result.resourceAddress ?? undefined,
    };
  }
  if (result.status === 'complete') {
    return {
      state: 'confirmed' as const,
      message: completeMessage,
      signature: result.signatures.at(-1),
      explorerUrl: result.explorerUrls.at(-1),
      resourceAddress: result.resourceAddress ?? undefined,
    };
  }
  if (result.status === 'confirmed_syncing') {
    return {
      state: 'syncing' as const,
      message: result.error?.message ?? 'Confirmed on-chain — syncing Meteora state.',
      signature: result.signatures.at(-1),
      explorerUrl: result.explorerUrls.at(-1),
      resourceAddress: result.resourceAddress ?? undefined,
    };
  }
  if (result.status === 'partially_complete') {
    return {
      state: 'partial' as const,
      message: result.error?.message
        ?? 'An earlier transaction confirmed, but the remaining steps need recovery.',
      signature: result.signatures.at(-1),
      explorerUrl: result.explorerUrls.at(-1),
      resourceAddress: result.resourceAddress ?? undefined,
    };
  }
  if (result.status === 'confirmation_unknown') {
    return {
      state: 'submitted' as const,
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
