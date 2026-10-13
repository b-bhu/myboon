import type { ClobBalance, DepositBridgeTransaction } from './predict.api';

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

// --- Deposit tracking persistence -------------------------------------------

export type DepositTrackingLogger = (message: string, ...details: unknown[]) => void;

export type StorageSetItem = (key: string, value: string) => Promise<void>;

/** Outcome of a bounded-retry snapshot save. */
export type DepositTrackingSaveResult =
  /** A write was confirmed. */
  | 'confirmed'
  /** Every attempt failed; callers must surface this to the user. */
  | 'failed'
  /**
   * The caller's `shouldContinue` gate ended the save early (a newer save
   * superseded it, or the caller closed). Deliberately not a failure: a
   * stale save must neither overwrite newer data nor be reported as one.
   */
  | 'superseded';

export interface PersistDepositTrackingOptions {
  /** Total attempts, including the first one. Defaults to 3. */
  retries?: number;
  /** Base delay in milliseconds; attempt N waits baseDelayMs * 2^(N-1). Defaults to 500. */
  baseDelayMs?: number;
  /** Injectable delay (defaults to a real setTimeout) so tests never wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable warning logger (defaults to console.warn); receives no payloads. */
  onError?: DepositTrackingLogger;
  /**
   * Checked before every attempt and around the backoff sleep. Returning
   * false abandons the save without another write and yields 'superseded'
   * instead of a failure, so an older in-flight save can never overwrite a
   * newer one.
   */
  shouldContinue?: () => boolean;
}

const DEFAULT_SAVE_ATTEMPTS = 3;
const DEFAULT_SAVE_BASE_DELAY_MS = 500;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Persist the tracked-deposit snapshot with bounded exponential-backoff
 * retries. Returns 'confirmed' when a write lands, 'failed' after every
 * attempt has failed, and 'superseded' when `shouldContinue` breaks the loop:
 * an abandoned stale save must not count as a failure. Callers surface a
 * 'failed' result to the user; the failures themselves are only logged,
 * without payloads or storage keys.
 */
export async function persistDepositTracking(
  setItem: StorageSetItem,
  key: string,
  value: string,
  options: PersistDepositTrackingOptions = {},
): Promise<DepositTrackingSaveResult> {
  const attempts = Math.max(1, options.retries ?? DEFAULT_SAVE_ATTEMPTS);
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? DEFAULT_SAVE_BASE_DELAY_MS);
  const sleep = options.sleep ?? defaultSleep;
  const shouldContinue = options.shouldContinue ?? (() => true);
  const onError = options.onError ?? ((message: string, ...details: unknown[]) => {
    console.warn(message, ...details);
  });

  try {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (!shouldContinue()) return 'superseded';
      try {
        await setItem(key, value);
        return 'confirmed';
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'unknown error';
        onError(`[predict] Deposit tracking save failed (attempt ${attempt}/${attempts}): ${detail}`);
        if (attempt < attempts) {
          if (!shouldContinue()) return 'superseded';
          await sleep(baseDelayMs * 2 ** (attempt - 1));
          // A newer save may have started (or the caller may have closed)
          // while this one was waiting: stop before writing again.
          if (!shouldContinue()) return 'superseded';
        }
      }
    }
  } catch (error) {
    // A rejected injectable sleep is not a storage failure; an in-flight save
    // that cannot proceed simply stops, without any write having occurred.
    onError(
      `[predict] Deposit tracking save aborted between attempts: ${
        error instanceof Error ? error.message : 'unknown error'
      }`,
    );
    return 'superseded';
  }
  return 'failed';
}

// --- Deposit status check classification ------------------------------------

/**
 * A status view as rendered in the modal. `retryable` marks the transient
 * "Couldn't check status" view of a failed status check, which is the only
 * view persistence drops down; a genuine error view never sets it.
 */
export interface PersistableDepositStatusView {
  tone: string;
  retryable?: boolean;
}

/**
 * Decide which status view may be persisted. Only the transient "Couldn't
 * check status" view of a failed status check is dropped: persisting it would
 * show a stale retry prompt on reopen. A genuine error view (e.g. a
 * Bridge-reported failed deposit) carries no `retryable` flag and is kept.
 */
export function statusViewToPersist<V extends PersistableDepositStatusView>(
  statusView: V | null | undefined,
): V | null {
  if (!statusView) return null;
  return statusView.retryable === true ? null : statusView;
}

export interface DepositStatusCheckInputs {
  /** Settlement of the Bridge status fetch (fulfilled transactions, rejected on failure). */
  transactionsResult: PromiseSettledResult<DepositBridgeTransaction[]>;
  /** Settlement of the CLOB balance fetch (fulfilled value or null, rejected on failure). */
  balanceResult: PromiseSettledResult<ClobBalance | null>;
}

export type DepositStatusCheckOutcome = 'error' | 'empty' | 'data';

/**
 * Classify a settled status check. A rejected Bridge status fetch is an error
 * state, never "no deposit yet"; a fulfilled empty list is genuinely empty.
 * A balance rejection is secondary: the status fetch carries the deposit
 * evidence, so it decides the outcome, while the balance rejection is only
 * reported so callers can log it.
 */
export function classifyDepositStatusCheck({
  transactionsResult,
  balanceResult,
}: DepositStatusCheckInputs): {
  outcome: DepositStatusCheckOutcome;
  balanceFailed: boolean;
} {
  if (transactionsResult.status === 'rejected') {
    return { outcome: 'error', balanceFailed: balanceResult.status === 'rejected' };
  }
  const balanceFailed = balanceResult.status === 'rejected';
  if (transactionsResult.value.length === 0) {
    return { outcome: 'empty', balanceFailed };
  }
  return { outcome: 'data', balanceFailed };
}
