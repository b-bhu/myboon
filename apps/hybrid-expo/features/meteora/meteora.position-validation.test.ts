import assert from 'node:assert/strict';
import test from 'node:test';
import type { MeteoraRangeRequest } from '@myboon/shared/meteora';
import { EMPTY_POSITION_DRAFT, type MeteoraPositionDraft } from './meteora.form';
import {
  createManualPositionRequest,
  isEmptyTokenAmount,
  shouldUseAutoFillQuote,
  validateMeteoraPositionDraft,
} from './meteora.position-validation';

const tokenX = { symbol: 'SOL', decimals: 9 };
const tokenY = { symbol: 'USDC', decimals: 6 };
const centeredRange: MeteoraRangeRequest = { kind: 'manual', minPrice: '99', maxPrice: '101' };

function draft(overrides: Partial<MeteoraPositionDraft> = {}): MeteoraPositionDraft {
  return {
    ...EMPTY_POSITION_DRAFT,
    requestedMinPrice: '99',
    requestedMaxPrice: '101',
    ...overrides,
  };
}

test('manual drafts allow one or both positive sides and normalize optional zero', () => {
  assert.equal(isEmptyTokenAmount(''), true);
  assert.equal(isEmptyTokenAmount('0.000'), true);
  assert.equal(isEmptyTokenAmount('00'), false);
  assert.equal(validateMeteoraPositionDraft({
    draft: draft({ amountX: '1.250000000', amountY: '' }), tokenX, tokenY,
  }).valid, true);
  assert.equal(validateMeteoraPositionDraft({
    draft: draft({ amountX: '0', amountY: '10.00' }), tokenX, tokenY,
  }).valid, true);
  const optionalZero = validateMeteoraPositionDraft({
    draft: draft({ amountX: '1', amountY: '0' }), tokenX, tokenY,
  });
  assert.equal(optionalZero.amountYError, null);
  assert.equal(validateMeteoraPositionDraft({
    draft: draft({ amountX: '1', amountY: '00' }), tokenX, tokenY,
  }).amountYError, 'Use a positive decimal amount');
  assert.equal(validateMeteoraPositionDraft({
    draft: draft({ amountX: '0', amountY: '0' }), tokenX, tokenY,
  }).blockerLabel, 'Enter an amount');
  assert.equal(validateMeteoraPositionDraft({
    draft: draft({ amountX: '', amountY: '' }), tokenX, tokenY,
  }).blockerLabel, 'Enter an amount');
});

test('manual validation reports invalid optional sides and u64 overflow', () => {
  const malformed = validateMeteoraPositionDraft({
    draft: draft({ amountX: '1', amountY: '-2' }), tokenX, tokenY,
  });
  assert.equal(malformed.valid, false);
  assert.equal(malformed.amountYError, 'Use a positive decimal amount');
  assert.equal(malformed.blockerLabel, 'Fix USDC amount');

  const overprecision = validateMeteoraPositionDraft({
    draft: draft({ amountX: '1.0000000001', amountY: '2' }), tokenX, tokenY,
  });
  assert.equal(overprecision.amountXError, 'Use no more than 9 decimal places');

  const tooLarge = validateMeteoraPositionDraft({
    draft: draft({ amountX: '18446744073.709551616', amountY: '' }), tokenX, tokenY,
  });
  assert.equal(tooLarge.amountXError, 'Amount is too large');
  assert.equal(tooLarge.blockerLabel, 'Fix SOL amount');
});

test('Auto-Fill accepts one source or an already-filled manual pair', () => {
  const one = validateMeteoraPositionDraft({
    draft: draft({ autoFill: true, amountX: '1' }), tokenX, tokenY,
  });
  assert.equal(one.valid, true);
  assert.equal(validateMeteoraPositionDraft({
    draft: draft({ autoFill: true, amountX: '1', amountY: '0.000000' }), tokenX, tokenY,
  }).valid, true);
  assert.equal(shouldUseAutoFillQuote(
    draft({ autoFill: true, amountX: '1', amountY: '0.000000' }),
    tokenX.decimals,
    tokenY.decimals,
  ), true);
  assert.equal(shouldUseAutoFillQuote(
    draft({ autoFill: true, amountX: '', amountY: '2' }),
    tokenX.decimals,
    tokenY.decimals,
  ), true);

  const both = validateMeteoraPositionDraft({
    draft: draft({ autoFill: true, amountX: '1', amountY: '2' }), tokenX, tokenY,
  });
  assert.equal(both.valid, true);
  assert.equal(both.blockerLabel, null);
  assert.equal(shouldUseAutoFillQuote(
    draft({ autoFill: true, amountX: '1', amountY: '2' }),
    tokenX.decimals,
    tokenY.decimals,
  ), false);

  const malformed = validateMeteoraPositionDraft({
    draft: draft({ autoFill: true, amountX: '1.0000000001', amountY: '2' }), tokenX, tokenY,
  });
  assert.equal(malformed.amountXError, 'Use no more than 9 decimal places');
  assert.equal(malformed.blockerLabel, 'Fix SOL amount');
  assert.equal(shouldUseAutoFillQuote(
    draft({ autoFill: true, amountX: '1.0000000001', amountY: '' }),
    tokenX.decimals,
    tokenY.decimals,
  ), false);

  const none = validateMeteoraPositionDraft({
    draft: draft({ autoFill: true }), tokenX, tokenY,
  });
  assert.equal(none.blockerLabel, 'Enter an amount');
  assert.equal(shouldUseAutoFillQuote(
    draft({ autoFill: true, amountX: '1', amountY: '2' }),
    tokenX.decimals,
    tokenY.decimals,
    true,
  ), false);
  assert.equal(validateMeteoraPositionDraft({
    draft: draft({ autoFill: true, amountX: '1', amountY: '2' }),
    tokenX,
    tokenY,
    addMode: true,
  }).valid, true);
});

test('explicit single-token funding requires its selected side but validates the other side', () => {
  const missing = validateMeteoraPositionDraft({
    draft: draft({ fundingMode: 'single', singleTokenSide: 'x', amountY: '2' }), tokenX, tokenY,
  });
  assert.equal(missing.amountXError, 'Enter an amount');
  assert.equal(missing.valid, false);

  const ignored = validateMeteoraPositionDraft({
    draft: draft({ fundingMode: 'single', singleTokenSide: 'x', amountX: '1', amountY: '-2' }), tokenX, tokenY,
  });
  assert.equal(ignored.amountYError, 'Use a positive decimal amount');
  assert.equal(ignored.valid, false);
});

test('range blockers distinguish missing edges and invalid manual ranges', () => {
  assert.equal(validateMeteoraPositionDraft({
    draft: draft({ amountX: '1', requestedMinPrice: '', requestedMaxPrice: '101' }), tokenX, tokenY,
  }).blockerLabel, 'Enter minimum price');
  assert.equal(validateMeteoraPositionDraft({
    draft: draft({ amountX: '1', requestedMinPrice: '99', requestedMaxPrice: '' }), tokenX, tokenY,
  }).blockerLabel, 'Enter maximum price');
  const reversed = validateMeteoraPositionDraft({
    draft: draft({ amountX: '1', requestedMinPrice: '101', requestedMaxPrice: '99' }), tokenX, tokenY,
  });
  assert.equal(reversed.rangeError, 'Minimum price must be below maximum price');
  assert.equal(reversed.blockerLabel, 'Fix price range');
  assert.equal(validateMeteoraPositionDraft({
    draft: draft({ amountX: '1', preset: 'balanced', requestedMinPrice: '', requestedMaxPrice: '' }), tokenX, tokenY,
  }).valid, true);
  assert.equal(validateMeteoraPositionDraft({
    draft: draft({ autoFill: true, amountX: '1', preset: 'manual', requestedMinPrice: '' }), tokenX, tokenY,
  }).blockerLabel, 'Enter minimum price');
  assert.equal(validateMeteoraPositionDraft({
    draft: draft({ amountX: '1', requestedMinPrice: '', requestedMaxPrice: '' }), tokenX, tokenY, addMode: true,
  }).valid, true);
});

test('explicit Zap mode takes precedence over Auto-Fill', () => {
  const result = validateMeteoraPositionDraft({
    draft: draft({ fundingMode: 'single', singleTokenSide: 'x', autoFill: true, amountX: '1' }),
    tokenX,
    tokenY,
  });
  assert.equal(result.valid, true);
  assert.equal(result.blockerLabel, null);
});

test('local executable bin validation blocks invalid token sides and 71 bins before SDK preparation', () => {
  const state = {
    poolAddress: 'pool', activeBinId: 100, activePrice: '100', binStep: 100,
    tokenX: { ...tokenX, address: 'x' }, tokenY: { ...tokenY, address: 'y' }, refreshedAt: new Date().toISOString(),
  } as const;
  assert.equal(validateMeteoraPositionDraft({
    draft: draft({ amountX: '1', requestedMinPrice: '90', requestedMaxPrice: '99' }), tokenX, tokenY, poolState: state,
  }).blockerLabel, 'Adjust token range');
  assert.equal(validateMeteoraPositionDraft({
    draft: draft({ amountY: '1', requestedMinPrice: '101', requestedMaxPrice: '110' }), tokenX, tokenY, poolState: state,
  }).blockerLabel, 'Adjust token range');
  assert.equal(validateMeteoraPositionDraft({
    draft: draft({ amountX: '1', amountY: '1', requestedMinPrice: '90', requestedMaxPrice: '99' }), tokenX, tokenY, poolState: state,
  }).blockerLabel, 'Adjust token range');
  assert.equal(validateMeteoraPositionDraft({
    draft: draft({ amountX: '1', requestedMinPrice: '70', requestedMaxPrice: '210' }), tokenX, tokenY, poolState: state,
  }).valid, false);
});

test('manual planner preserves exact strings and chooses the explicit deposit route', () => {
  const common = { draft: draft(), poolAddress: 'pool', range: centeredRange, tokenX, tokenY };
  assert.deepEqual(createManualPositionRequest({
    ...common, draft: draft({ amountX: '1.250000000', amountY: '2.00' }),
  }), {
    poolAddress: 'pool', strategy: 'spot', range: centeredRange, depositMode: 'two_token',
    tokenXAmount: '1.250000000', tokenYAmount: '2.00',
  });
  assert.deepEqual(createManualPositionRequest({
    ...common, draft: draft({ amountX: '1', amountY: '0' }),
  }), {
    poolAddress: 'pool', strategy: 'spot', range: centeredRange, depositMode: 'single_sided',
    inputToken: 'x', amount: '1',
  });
  assert.deepEqual(createManualPositionRequest({
    ...common, draft: draft({ amountX: '', amountY: '2.00' }),
  }), {
    poolAddress: 'pool', strategy: 'spot', range: centeredRange, depositMode: 'single_sided',
    inputToken: 'y', amount: '2.00',
  });
  assert.deepEqual(createManualPositionRequest({
    ...common, draft: draft({ autoFill: true, amountX: '1.00', amountY: '2.00' }),
  }), {
    poolAddress: 'pool', strategy: 'spot', range: centeredRange, depositMode: 'two_token',
    tokenXAmount: '1.00', tokenYAmount: '2.00',
  });
});

test('manual planner rejects Auto-Fill, explicit single-token mode, and invalid drafts', () => {
  const input = { draft: draft({ amountX: '1' }), poolAddress: 'pool', range: centeredRange, tokenX, tokenY };
  assert.throws(() => createManualPositionRequest({ ...input, draft: draft({ autoFill: true, amountX: '1' }) }), /Auto-Fill/);
  assert.throws(() => createManualPositionRequest({ ...input, draft: draft({ fundingMode: 'single', amountX: '1' }) }), /single-token/);
  assert.throws(() => createManualPositionRequest({ ...input, draft: draft() }), /Enter an amount/);
  assert.throws(() => createManualPositionRequest({
    ...input, draft: draft({ amountX: '01.25', amountY: '2' }),
  }), /Fix SOL amount/);
});
