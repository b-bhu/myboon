import type { BridgeQuote, DepositBridgeTransaction } from './predict.api';

export type WithdrawalTrackingStatus =
  | 'PREPARED'
  | 'SUBMITTING'
  | 'SUBMITTED'
  | 'AMBIGUOUS'
  | 'BRIDGING'
  | 'COMPLETED'
  | 'FAILED';

export interface TrackedWithdrawal {
  amount: number;
  recipientAddress: string;
  bridgeAddress: string;
  transactionId: string | null;
  transactionHash: string | null;
  quote: BridgeQuote;
  status: WithdrawalTrackingStatus;
  startedAt: number;
  updatedAt: number;
  lastError: string | null;
}

export interface WithdrawalRelayerStatus {
  state: string;
  transactionId: string;
  transactionHash: string | null;
  errorMessage: string | null;
}

const WITHDRAWAL_STATUS_RANK: Record<WithdrawalTrackingStatus, number> = {
  PREPARED: 0,
  SUBMITTING: 1,
  SUBMITTED: 2,
  AMBIGUOUS: 2,
  BRIDGING: 3,
  COMPLETED: 4,
  FAILED: 4,
};

export function createPreparedWithdrawal(input: {
  amount: number;
  recipientAddress: string;
  bridgeAddress: string;
  quote: BridgeQuote;
  now?: number;
}): TrackedWithdrawal {
  const now = input.now ?? Date.now();
  return {
    amount: input.amount,
    recipientAddress: input.recipientAddress,
    bridgeAddress: input.bridgeAddress,
    transactionId: null,
    transactionHash: null,
    quote: input.quote,
    status: 'PREPARED',
    startedAt: now,
    updatedAt: now,
    lastError: null,
  };
}

function updateTracking(
  tracking: TrackedWithdrawal,
  patch: Partial<TrackedWithdrawal>,
  now = Date.now(),
): TrackedWithdrawal {
  const unchanged = Object.entries(patch).every(([key, value]) => (
    tracking[key as keyof TrackedWithdrawal] === value
  ));
  if (unchanged) return tracking;
  return { ...tracking, ...patch, updatedAt: now };
}

function transitionTracking(
  tracking: TrackedWithdrawal,
  patch: Partial<TrackedWithdrawal> & { status: WithdrawalTrackingStatus },
  now?: number,
): TrackedWithdrawal {
  if (isWithdrawalTerminal(tracking)) return tracking;
  if (WITHDRAWAL_STATUS_RANK[patch.status] < WITHDRAWAL_STATUS_RANK[tracking.status]) {
    return tracking;
  }
  return updateTracking(tracking, patch, now);
}

export function markWithdrawalSubmitting(tracking: TrackedWithdrawal, now?: number): TrackedWithdrawal {
  return transitionTracking(tracking, { status: 'SUBMITTING', lastError: null }, now);
}

export function markWithdrawalSubmitted(
  tracking: TrackedWithdrawal,
  transactionId: string | null,
  transactionHash: string | null,
  now?: number,
): TrackedWithdrawal {
  return transitionTracking(tracking, {
    status: 'SUBMITTED',
    transactionId,
    transactionHash,
    lastError: null,
  }, now);
}

export function markWithdrawalAmbiguous(
  tracking: TrackedWithdrawal,
  errorMessage: string,
  now?: number,
): TrackedWithdrawal {
  return transitionTracking(tracking, { status: 'AMBIGUOUS', lastError: errorMessage }, now);
}

export function markWithdrawalBridging(
  tracking: TrackedWithdrawal,
  transactionId: string | null,
  transactionHash: string | null,
  now?: number,
): TrackedWithdrawal {
  return transitionTracking(tracking, {
    status: 'BRIDGING',
    transactionId: transactionId ?? tracking.transactionId,
    transactionHash: transactionHash ?? tracking.transactionHash,
    lastError: null,
  }, now);
}

export function markWithdrawalFailed(
  tracking: TrackedWithdrawal,
  errorMessage: string,
  now?: number,
): TrackedWithdrawal {
  return transitionTracking(tracking, { status: 'FAILED', lastError: errorMessage }, now);
}

export function isWithdrawalTerminal(tracking: TrackedWithdrawal): boolean {
  return tracking.status === 'COMPLETED' || tracking.status === 'FAILED';
}

function bridgeAmountMatches(transaction: DepositBridgeTransaction, tracking: TrackedWithdrawal): boolean {
  if (!transaction.fromAmountBaseUnit) return true;
  const amount = Number(transaction.fromAmountBaseUnit) / 1e6;
  const tolerance = Math.max(0.01, tracking.amount * 0.005);
  return Number.isFinite(amount) && Math.abs(amount - tracking.amount) <= tolerance;
}

function latestBridgeTransaction(
  transactions: DepositBridgeTransaction[],
  tracking: TrackedWithdrawal,
): DepositBridgeTransaction | null {
  const matching = transactions.filter((transaction) => {
    if (!bridgeAmountMatches(transaction, tracking)) return false;
    return typeof transaction.createdTimeMs !== 'number'
      || transaction.createdTimeMs >= tracking.startedAt - 30_000;
  });
  return [...matching].sort((a, b) => (b.createdTimeMs ?? 0) - (a.createdTimeMs ?? 0))[0] ?? null;
}

/** Reconcile persisted intent against both relayer and Bridge authorities after restart. */
export function reconcileWithdrawalTracking(
  tracking: TrackedWithdrawal,
  bridgeTransactions: DepositBridgeTransaction[],
  relayer: WithdrawalRelayerStatus | null,
  now = Date.now(),
): TrackedWithdrawal {
  if (isWithdrawalTerminal(tracking)) return tracking;
  const bridge = latestBridgeTransaction(bridgeTransactions, tracking);
  const transactionHash = bridge?.txHash ?? relayer?.transactionHash ?? tracking.transactionHash;
  const transactionId = relayer?.transactionId ?? tracking.transactionId;

  if (bridge?.status === 'COMPLETED') {
    return transitionTracking(tracking, {
      status: 'COMPLETED', transactionId, transactionHash, lastError: null,
    }, now);
  }
  if (bridge?.status === 'FAILED') {
    return transitionTracking(tracking, {
      status: 'FAILED', transactionId, transactionHash,
      lastError: 'Bridge reported that the withdrawal failed.',
    }, now);
  }
  if (bridge?.status) {
    return transitionTracking(tracking, {
      status: 'BRIDGING', transactionId, transactionHash, lastError: null,
    }, now);
  }

  if (relayer?.state === 'STATE_FAILED' || relayer?.state === 'STATE_INVALID') {
    return transitionTracking(tracking, {
      status: 'FAILED', transactionId, transactionHash,
      lastError: relayer.errorMessage ?? 'Relayer reported that the withdrawal failed.',
    }, now);
  }
  if (
    relayer?.state === 'STATE_EXECUTED'
    || relayer?.state === 'STATE_MINED'
    || relayer?.state === 'STATE_CONFIRMED'
  ) {
    return transitionTracking(tracking, {
      status: 'BRIDGING', transactionId, transactionHash, lastError: null,
    }, now);
  }
  if (relayer?.state === 'STATE_NEW') {
    return transitionTracking(tracking, {
      status: 'SUBMITTED', transactionId, transactionHash, lastError: null,
    }, now);
  }

  return tracking;
}
