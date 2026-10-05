import assert from 'node:assert/strict';
import test from 'node:test';
import type { MeteoraExecutionTab, MeteoraOperationState } from './meteora.form';
import { getMeteoraPreviewBlocker, getMeteoraPreviewCta, type MeteoraPreviewCtaInput } from './meteora.preview-cta';

function input(overrides: Partial<MeteoraPreviewCtaInput> = {}): MeteoraPreviewCtaInput {
  return {
    loading: false,
    poolAvailable: true,
    activeTab: 'position' as MeteoraExecutionTab,
    positionFundingMode: 'both',
    locallyValid: true,
    insufficientBalance: false,
    preview: { canExecute: true },
    previewError: null,
    previewLoading: false,
    previewExpired: false,
    stalePool: false,
    walletConnected: true,
    walletSupported: true,
    operationState: 'editing' as MeteoraOperationState,
    addMode: false,
    ...overrides,
  };
}

test('error without active loading is an enabled Retry preview CTA', () => {
  assert.deepEqual(getMeteoraPreviewCta(input({ preview: null, previewError: 'failed' })), {
    label: 'Retry preview', disabled: false, busy: false,
  });
  assert.deepEqual(getMeteoraPreviewCta(input({ preview: null, previewError: 'failed', previewLoading: true })), {
    label: 'Preparing preview…', disabled: true, busy: true,
  });
  assert.deepEqual(getMeteoraPreviewCta(input({ preview: null })), {
    label: 'Prepare preview', disabled: false, busy: false,
  });
});

test('input and range errors require an edit while failed pool refreshes remain retryable', () => {
  assert.equal(getMeteoraPreviewBlocker({ code: 'INVALID_RANGE', message: 'Invalid range' }), 'Adjust range');
  assert.equal(getMeteoraPreviewBlocker({ code: 'RANGE_TOO_WIDE' }), 'Adjust range');
  assert.equal(getMeteoraPreviewBlocker({ code: 'INVALID_DEPOSIT_COMBINATION', message: 'Auto-Fill requires a range containing the current active bin' }), 'Adjust range');
  assert.equal(getMeteoraPreviewBlocker({ code: 'INVALID_DEPOSIT_COMBINATION', message: 'The selected amount and range cannot produce a two-token Auto-Fill quote' }), 'Adjust amount or range');
  assert.equal(getMeteoraPreviewBlocker({ code: 'AMOUNT_PRECISION_EXCEEDED' }), 'Fix amounts');
  assert.equal(getMeteoraPreviewBlocker({ code: 'SDK_ERROR', message: 'Failed to refresh Meteora pool state' }), null);
  assert.equal(getMeteoraPreviewBlocker(new Error('timeout')), null);
  assert.deepEqual(getMeteoraPreviewCta(input({ preview: null, previewError: 'Invalid range', previewBlocker: 'Adjust range' })), {
    label: 'Adjust range', disabled: true, busy: false,
  });
});

test('insufficient balance remains a nonbusy blocker during quote states', () => {
  for (const overrides of [
    { previewLoading: true },
    { previewError: 'failed', previewLoading: false },
    { preview: null },
  ]) {
    assert.deepEqual(getMeteoraPreviewCta(input({ insufficientBalance: true, ...overrides })), {
      label: 'Insufficient token balance', disabled: true, busy: false,
    });
  }
});

test('local validation and unsupported wallets remain blockers', () => {
  assert.deepEqual(getMeteoraPreviewCta(input({ locallyValid: false, preview: null })), {
    label: 'Enter an amount', disabled: true, busy: false,
  });
  assert.deepEqual(getMeteoraPreviewCta(input({ walletSupported: false })), {
    label: 'Wallet cannot sign transactions', disabled: true, busy: false,
  });
});

test('an execution prerequisite blocks a valid form before review', () => {
  assert.deepEqual(getMeteoraPreviewCta(input({ executionBlocker: 'Calculating native cost' })), {
    label: 'Calculating native cost', disabled: true, busy: false,
  });
  assert.deepEqual(getMeteoraPreviewCta(input({ executionBlocker: 'Retry native SOL balance' })), {
    label: 'Retry native SOL balance', disabled: true, busy: false,
  });
  // Form errors retain their field-specific instruction; the external read
  // becomes relevant only after the user has supplied a valid draft.
  assert.deepEqual(getMeteoraPreviewCta(input({ locallyValid: false, formBlocker: 'Fix SOL amount', executionBlocker: 'Calculating native cost' })), {
    label: 'Fix SOL amount', disabled: true, busy: false,
  });
});

test('uses the actual invalid field instead of claiming a prefilled range is missing', () => {
  for (const formBlocker of ['Fix SOL amount', 'Enter minimum price', 'Enter maximum price', 'Fix price range']) {
    assert.deepEqual(getMeteoraPreviewCta(input({ locallyValid: false, formBlocker })), {
      label: formBlocker, disabled: true, busy: false,
    });
  }
  assert.deepEqual(getMeteoraPreviewCta(input({ locallyValid: true, preview: null, formBlocker: null })), {
    label: 'Prepare preview', disabled: false, busy: false,
  });
});

test('ready and blocked previews preserve CTA outcomes', () => {
  assert.deepEqual(getMeteoraPreviewCta(input({ preview: { canExecute: false } })), {
    label: 'Fix issues above', disabled: true, busy: false,
  });
  assert.deepEqual(getMeteoraPreviewCta(input({ preview: { canExecute: true }, activeTab: 'limit' })), {
    label: 'Place limit order', disabled: false, busy: false,
  });
  assert.deepEqual(getMeteoraPreviewCta(input({ preview: { canExecute: true }, positionFundingMode: 'single' })), {
    label: 'Start with one token', disabled: false, busy: false,
  });
});

test('transaction, success, and partial states take priority', () => {
  assert.deepEqual(getMeteoraPreviewCta(input({ operationState: 'building', previewError: 'failed' })), {
    label: 'Building transaction…', disabled: true, busy: true,
  });
  assert.deepEqual(getMeteoraPreviewCta(input({ operationState: 'success', activeTab: 'limit' })), {
    label: 'Order placed', disabled: true, busy: false,
  });
  assert.deepEqual(getMeteoraPreviewCta(input({ operationState: 'success', addMode: true })), {
    label: 'Liquidity added', disabled: true, busy: false,
  });
  assert.deepEqual(getMeteoraPreviewCta(input({ operationState: 'partial' })), {
    label: 'Transaction needs recovery', disabled: true, busy: false,
  });
});
