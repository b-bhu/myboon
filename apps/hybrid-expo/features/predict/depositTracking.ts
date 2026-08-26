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
const MINIMUM_BALANCE_TOLERANCE = 0.05;
const RELATIVE_BALANCE_TOLERANCE = 0.02;

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
  return transaction?.status === 'COMPLETED';
}

function balanceMatchesTrackedDeposit(
  balanceDelta: number | null,
  intendedAmount: number | undefined,
): boolean {
  if (balanceDelta === null || !Number.isFinite(balanceDelta) || balanceDelta <= 0) return false;
  if (intendedAmount === undefined || !Number.isFinite(intendedAmount) || intendedAmount <= 0) return false;

  // A small tolerance allows for bridge fees and decimal rounding, while
  // preventing an unrelated minor balance change from completing this flow.
  const tolerance = Math.max(
    MINIMUM_BALANCE_TOLERANCE,
    intendedAmount * RELATIVE_BALANCE_TOLERANCE,
  );
  return balanceDelta >= intendedAmount - tolerance;
}

/**
 * Either upstream completion or a matching spendable-balance credit is final.
 * The Bridge status feed can lag behind the CLOB balance, and the user should
 * not remain stuck in "Waiting" after the deposited funds are usable.
 */
export function canCompleteTrackedDeposit(
  balanceDelta: number | null,
  intendedAmount: number | undefined,
  transaction: DepositBridgeTransaction | null,
): boolean {
  return isCompletedDepositEvidence(transaction)
    || balanceMatchesTrackedDeposit(balanceDelta, intendedAmount);
}
