import type { DepositBridgeTransaction } from './predict.api';

export interface TrackedDepositEvidence {
  chainId?: string;
  tokenAddress?: string;
  tokenDecimals?: number;
  destinationChainId?: string;
  destinationTokenAddress?: string;
  intendedAmount?: number;
  baselineTransactionKeys: string[];
  hasStatusSnapshot: boolean;
  startedAt: number;
}

const TRANSACTION_TIME_TOLERANCE_MS = 30_000;
const MINIMUM_AMOUNT_TOLERANCE = 0.01;
const RELATIVE_AMOUNT_TOLERANCE = 0.005;

export function depositTransactionKey(transaction: DepositBridgeTransaction): string {
  return [
    transaction.fromChainId ?? '',
    transaction.fromTokenAddress ?? '',
    transaction.fromAmountBaseUnit ?? '',
    transaction.toChainId ?? '',
    transaction.toTokenAddress ?? '',
    transaction.status ?? '',
    transaction.txHash ?? '',
    transaction.createdTimeMs ?? '',
  ].join(':');
}

function amountMatches(transaction: DepositBridgeTransaction, tracked: TrackedDepositEvidence): boolean {
  if (tracked.intendedAmount === undefined) return false;
  if (tracked.tokenDecimals === undefined || !transaction.fromAmountBaseUnit) return false;
  const baseUnits = Number(transaction.fromAmountBaseUnit);
  if (!Number.isFinite(baseUnits)) return false;
  const observedAmount = baseUnits / (10 ** tracked.tokenDecimals);
  const tolerance = Math.max(
    MINIMUM_AMOUNT_TOLERANCE,
    tracked.intendedAmount * RELATIVE_AMOUNT_TOLERANCE,
  );
  return Math.abs(observedAmount - tracked.intendedAmount) <= tolerance;
}

export function matchingDepositTransactions(
  transactions: DepositBridgeTransaction[],
  tracked: TrackedDepositEvidence,
): DepositBridgeTransaction[] {
  const baselineKeys = new Set(tracked.baselineTransactionKeys);
  return transactions.filter((transaction) => {
    if (!tracked.chainId || transaction.fromChainId !== tracked.chainId) return false;
    if (!tracked.tokenAddress) return false;
    if (transaction.fromTokenAddress?.toLowerCase() !== tracked.tokenAddress.toLowerCase()) return false;
    if (!tracked.destinationChainId || transaction.toChainId !== tracked.destinationChainId) return false;
    if (!tracked.destinationTokenAddress) return false;
    if (transaction.toTokenAddress?.toLowerCase() !== tracked.destinationTokenAddress.toLowerCase()) return false;
    if (!amountMatches(transaction, tracked)) return false;
    if (baselineKeys.has(depositTransactionKey(transaction))) return false;
    if (typeof transaction.createdTimeMs === 'number') {
      return transaction.createdTimeMs >= tracked.startedAt - TRANSACTION_TIME_TOLERANCE_MS;
    }
    return tracked.hasStatusSnapshot;
  });
}

export function latestDepositTransaction(
  transactions: DepositBridgeTransaction[],
): DepositBridgeTransaction | null {
  if (transactions.length === 0) return null;
  return [...transactions].sort((a, b) => {
    const aTime = a.createdTimeMs ?? Number.MAX_SAFE_INTEGER;
    const bTime = b.createdTimeMs ?? Number.MAX_SAFE_INTEGER;
    return bTime - aTime;
  })[0] ?? null;
}

export function isCompletedDepositEvidence(transaction: DepositBridgeTransaction | null): boolean {
  // Earlier Bridge states are progress only. They do not prove the tracked
  // deposit caused a balance delta, so an unrelated sell could otherwise
  // complete the flow while this deposit is still bridging.
  return transaction?.status === 'COMPLETED';
}

/** Balance is only a second confirmation; it can never complete tracking alone. */
export function canCompleteTrackedDeposit(
  balanceIncreased: boolean,
  transaction: DepositBridgeTransaction | null,
): boolean {
  return balanceIncreased && isCompletedDepositEvidence(transaction);
}
