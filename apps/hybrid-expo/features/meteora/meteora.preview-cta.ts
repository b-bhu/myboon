import type {
  MeteoraExecutionTab,
  MeteoraFundingMode,
  MeteoraOperationState,
} from './meteora.form';

export interface MeteoraPreviewCtaInput {
  loading: boolean;
  poolAvailable: boolean;
  activeTab: MeteoraExecutionTab;
  positionFundingMode: MeteoraFundingMode;
  locallyValid: boolean;
  formBlocker?: string | null;
  /** A current external prerequisite (for example a native-cost read) that must
   * hold even when the form itself is valid. */
  executionBlocker?: string | null;
  insufficientBalance: boolean;
  preview: { canExecute: boolean } | null;
  previewError: string | null;
  previewBlocker?: string | null;
  previewLoading: boolean;
  previewExpired: boolean;
  stalePool: boolean;
  walletConnected: boolean;
  walletSupported: boolean;
  operationState: MeteoraOperationState;
  addMode: boolean;
}

export interface MeteoraPreviewCtaState {
  label: string;
  disabled: boolean;
  busy: boolean;
}

export function getMeteoraPreviewCta({
  loading,
  poolAvailable,
  activeTab,
  positionFundingMode,
  locallyValid,
  formBlocker,
  executionBlocker,
  insufficientBalance,
  preview,
  previewError,
  previewBlocker,
  previewLoading,
  previewExpired,
  stalePool,
  walletConnected,
  walletSupported,
  operationState,
  addMode,
}: MeteoraPreviewCtaInput): MeteoraPreviewCtaState {
  if (loading || !poolAvailable) return { label: 'Loading pool…', disabled: true, busy: true };
  if (operationState === 'building') {
    return { label: 'Building transaction…', disabled: true, busy: true };
  }
  if (operationState === 'simulating') {
    return { label: 'Simulating…', disabled: true, busy: true };
  }
  if (operationState === 'awaiting_wallet') {
    return { label: 'Approve in wallet', disabled: true, busy: true };
  }
  if (operationState === 'submitted') {
    return { label: 'Submitted — checking transaction', disabled: true, busy: true };
  }
  if (operationState === 'confirming') {
    return { label: 'Confirming…', disabled: true, busy: true };
  }
  if (operationState === 'syncing') {
    return { label: 'Confirmed — syncing', disabled: true, busy: true };
  }
  if (operationState === 'success') {
    return {
      label: addMode ? 'Liquidity added' : activeTab === 'position' ? 'Position created' : 'Order placed',
      disabled: true,
      busy: false,
    };
  }
  if (operationState === 'partial') {
    return { label: 'Transaction needs recovery', disabled: true, busy: false };
  }
  if (!walletConnected) return { label: addMode ? 'Add liquidity' : 'Create position', disabled: true, busy: false };
  if (insufficientBalance) return { label: 'Insufficient token balance', disabled: true, busy: false };
  if (!locallyValid) {
    return {
      label: formBlocker ?? (activeTab === 'position' ? 'Enter an amount' : 'Enter amount and target price'),
      disabled: true,
      busy: false,
    };
  }
  if (executionBlocker) return { label: executionBlocker, disabled: true, busy: false };
  if (previewLoading) return { label: 'Preparing preview…', disabled: true, busy: true };
  if (previewError) return { label: previewBlocker ?? 'Retry preview', disabled: !!previewBlocker, busy: false };
  if (stalePool || previewExpired) return { label: 'Refresh preview', disabled: false, busy: false };
  if (!walletSupported) {
    return { label: 'Wallet cannot sign transactions', disabled: true, busy: false };
  }
  if (!preview) return { label: 'Prepare preview', disabled: false, busy: false };
  if (!preview.canExecute) return { label: 'Fix issues above', disabled: true, busy: false };
  if (activeTab === 'limit') return { label: 'Place limit order', disabled: false, busy: false };
  if (positionFundingMode === 'single') {
    return { label: 'Start with one token', disabled: false, busy: false };
  }
  return { label: addMode ? 'Add liquidity' : 'Create position', disabled: false, busy: false };
}

/** Input/range failures need an edit; retrying the same request cannot fix them. */
export function getMeteoraPreviewBlocker(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('code' in error)) return null;
  const code = error.code;
  if (code === 'INVALID_RANGE' || code === 'RANGE_TOO_WIDE') return 'Adjust range';
  if (code === 'INVALID_DEPOSIT_COMBINATION') {
    const message = 'message' in error ? String(error.message) : '';
    if (/amount.*range|range.*amount/i.test(message)) return 'Adjust amount or range';
    if (/range|active bin/i.test(message)) return 'Adjust range';
    return 'Fix amounts';
  }
  if (['EMPTY_AMOUNT', 'AMOUNT_FORMAT_INVALID', 'AMOUNT_PRECISION_EXCEEDED', 'AMOUNT_NOT_POSITIVE', 'AMOUNT_OVERFLOW'].includes(String(code))) {
    return 'Fix amounts';
  }
  return null;
}
