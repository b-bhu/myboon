import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  MeteoraAutoFillQuote,
  MeteoraCreatePositionPreview,
  MeteoraSdkClient,
} from '@myboon/shared/meteora';
import {
  estimateAutoFillAmounts,
  prepareAutoFillPosition,
  type MeteoraAutoFillSdk,
} from './meteora.auto-fill';
import { EMPTY_POSITION_DRAFT } from './meteora.form';
import { exceedsBalance } from './meteora.position-form';

function estimate(overrides: Partial<Parameters<typeof estimateAutoFillAmounts>[0]> = {}) {
  return estimateAutoFillAmounts({
    draft: {
      ...EMPTY_POSITION_DRAFT,
      autoFill: true,
      amountX: '0.038028006',
      requestedMinPrice: '118.888',
      requestedMaxPrice: '122.165',
    },
    currentPrice: '120.516',
    binStep: 4,
    tokenXDecimals: 9,
    tokenYDecimals: 6,
    ...overrides,
  });
}

test('shows an immediate display estimate and flags a zero opposite-token balance', () => {
  const amounts = estimate();
  assert.equal(amounts?.amountX, '0.038028006');
  assert.ok(Number(amounts?.amountY) > 0);
  assert.equal(exceedsBalance(amounts!.amountY, '0', true), true);
});

test('display estimates do not falsely block a nonzero balance before the live bin quote', () => {
  assert.equal(exceedsBalance('4.582983', '4', true), false);
  assert.equal(exceedsBalance('4.582983', '4', false), true);
  assert.equal(exceedsBalance('4.582983', '0.000', true), true);
  assert.equal(exceedsBalance('4.582983', null, true), false);
});

test('estimates either input direction at the output token precision', () => {
  const draft = {
    ...EMPTY_POSITION_DRAFT,
    autoFill: true,
    amountY: '1.003343',
    requestedMinPrice: '118.888',
    requestedMaxPrice: '122.165',
  };
  const fromY = estimate({ draft });
  assert.equal(fromY?.amountY, '1.003343');
  assert.match(fromY!.amountX, /^\d+(?:\.\d{1,9})?$/);
  const integerOutput = estimate({ tokenYDecimals: 0 });
  assert.equal(integerOutput?.amountX, '0.038028006');
  assert.match(integerOutput!.amountY, /^\d+$/);
  assert.equal(draft.amountX, '', 'display estimate must not write to the transaction draft');
});

test('preserves large amounts and small scientific pool prices without floating point rounding', () => {
  const draft = {
    ...EMPTY_POSITION_DRAFT,
    autoFill: true,
    amountX: '4503599627.370496561',
    requestedMinPrice: '1',
    requestedMaxPrice: '3',
  };
  assert.deepEqual(estimate({ draft, currentPrice: '2', binStep: 10_000, tokenYDecimals: 9 }), {
    amountX: draft.amountX,
    amountY: '13510798882.111489683',
  });
  assert.deepEqual(estimate({
    draft: { ...draft, amountX: '1', requestedMinPrice: '0.000000001', requestedMaxPrice: '0.000000003' },
    currentPrice: '2e-9', binStep: 10_000, tokenYDecimals: 9,
  }), { amountX: '1', amountY: '0.000000003' });
  assert.deepEqual(estimate({
    draft: { ...draft, amountX: '0', amountY: '1', requestedMinPrice: '1', requestedMaxPrice: '3' },
    currentPrice: '2', binStep: 10_000,
  }), { amountX: '0.333333333', amountY: '1' });
});

test('range and strategy estimates match offline SDK Auto-Fill fixtures in both directions', () => {
  // @meteora-ag/dlmm 1.9.13, active bin 0, empty active reserves, bins -4..8.
  const fixtures = [
    { strategy: 'spot' as const, fromX: '0.552033', fromY: '1.811483' },
    { strategy: 'curve' as const, fromX: '0.520474', fromY: '1.921324' },
    { strategy: 'bid_ask' as const, fromX: '0.581412', fromY: '1.71995' },
  ];
  for (const fixture of fixtures) {
    const draft = {
      ...EMPTY_POSITION_DRAFT, autoFill: true, strategy: fixture.strategy,
      amountX: '1', amountY: '',
      requestedMinPrice: String(1.01 ** -4), requestedMaxPrice: String(1.01 ** 8),
    };
    const context = { draft, currentPrice: '1', binStep: 100, tokenXDecimals: 6, tokenYDecimals: 6 };
    assert.deepEqual(estimate(context), { amountX: '1', amountY: fixture.fromX });
    assert.deepEqual(estimate({ ...context, draft: { ...draft, amountX: '', amountY: '1' } }), {
      amountX: fixture.fromY, amountY: '1',
    });
  }
});

test('range moves change the calculated amount without changing the source amount or draft', () => {
  const draft = {
    ...EMPTY_POSITION_DRAFT, autoFill: true, amountX: '1',
    requestedMinPrice: String(1.01 ** -8), requestedMaxPrice: String(1.01 ** 8),
  };
  const context = { draft, currentPrice: '1', binStep: 100, tokenXDecimals: 6, tokenYDecimals: 6 };
  const centered = estimate(context)!;
  const narrowerY = estimate({ ...context, draft: { ...draft, requestedMinPrice: String(1.01 ** -2) } })!;
  const narrowerX = estimate({ ...context, draft: { ...draft, requestedMaxPrice: String(1.01 ** 2) } })!;
  assert.ok(Number(narrowerY.amountY) < Number(centered.amountY));
  assert.ok(Number(narrowerX.amountY) > Number(centered.amountY));
  assert.equal(narrowerY.amountX, '1');
  assert.equal(narrowerX.amountX, '1');
  assert.equal(draft.amountY, '');
});

test('manual two-token inputs stay manual while Auto-Fill is enabled', () => {
  const draft = {
    ...EMPTY_POSITION_DRAFT,
    autoFill: true,
    amountX: '1',
    amountY: '2',
    requestedMinPrice: '118.888',
    requestedMaxPrice: '122.165',
  };
  assert.equal(estimate({ draft }), null);
});

test('does not estimate invalid amounts, one-sided ranges, or manual funding', () => {
  const draft = {
    ...EMPTY_POSITION_DRAFT,
    autoFill: true,
    amountX: '1',
    requestedMinPrice: '118.888',
    requestedMaxPrice: '122.165',
  };
  for (const patch of [
    { autoFill: false }, { fundingMode: 'single' as const }, { amountY: '1' },
    { amountX: '' }, { amountX: '-1' }, { amountX: '0.0000000001' },
    { requestedMinPrice: '121' }, { requestedMaxPrice: '120' }, { requestedMinPrice: '120.516' },
  ]) {
    assert.equal(estimate({ draft: { ...draft, ...patch } }), null);
  }
  assert.equal(estimate({ currentPrice: null }), null);
  assert.equal(estimate({ currentPrice: 'NaN' }), null);
  assert.equal(estimate({ tokenYDecimals: -1 }), null);
  assert.equal(estimate({ binStep: 0 }), null);
  assert.equal(estimate({ binStep: NaN }), null);
  assert.equal(estimate({ draft: { ...draft, requestedMinPrice: '1', requestedMaxPrice: '10000' }, binStep: 1 }), null);
  assert.equal(estimate({
    draft: { ...draft, amountX: '18446744073.709551615', requestedMinPrice: '1', requestedMaxPrice: '3' },
    currentPrice: '2', binStep: 10_000, tokenYDecimals: 9,
  }), null, 'an estimate must respect the output token atomic limit');
});

const request: Parameters<MeteoraSdkClient['quoteAutoFill']>[0] = {
  poolAddress: 'pool-address',
  strategy: 'spot',
  range: { kind: 'manual', minPrice: '1.2', maxPrice: '1.8' },
  inputToken: 'x',
  amount: '9007199254740993.123456789',
};

const quote = {
  tokenXAmount: '9007199254740993.123456789',
  tokenYAmount: '0.000000000000000123456789',
} as MeteoraAutoFillQuote;

const preview = { previewId: 'preview-1' } as unknown as MeteoraCreatePositionPreview;

function sdkWith(
  quoteAutoFill: MeteoraAutoFillSdk['quoteAutoFill'],
  previewCreatePosition: MeteoraAutoFillSdk['previewCreatePosition'],
): MeteoraAutoFillSdk {
  return { quoteAutoFill, previewCreatePosition };
}

test('publishes exact quote amounts before preview failure', async () => {
  const events: string[] = [];
  const sdk = sdkWith(
    async () => quote,
    async () => {
      events.push('preview');
      throw new Error('preview failed');
    },
  );

  await assert.rejects(
    () => prepareAutoFillPosition(sdk, request, (amounts) => {
      events.push(`quote:${amounts.amountX}:${amounts.amountY}`);
    }),
    /preview failed/,
  );
  assert.deepEqual(events, [
    `quote:${quote.tokenXAmount}:${quote.tokenYAmount}`,
    'preview',
  ]);
});

test('does not publish values when quoting fails', async () => {
  let published = false;
  const sdk = sdkWith(
    async () => { throw new Error('quote failed'); },
    async () => preview,
  );

  await assert.rejects(
    () => prepareAutoFillPosition(sdk, request, () => { published = true; }),
    /quote failed/,
  );
  assert.equal(published, false);
});

test('returns the exact SDK preview and forwards quote precision', async () => {
  let received: unknown;
  const sdk = sdkWith(
    async () => quote,
    async (previewRequest) => {
      received = previewRequest;
      return preview;
    },
  );
  let published: unknown;
  const result = await prepareAutoFillPosition(sdk, request, (amounts) => {
    published = amounts;
  });

  assert.equal(result, preview);
  assert.deepEqual(published, {
    amountX: quote.tokenXAmount,
    amountY: quote.tokenYAmount,
  });
  assert.deepEqual(received, {
    poolAddress: request.poolAddress,
    strategy: request.strategy,
    range: request.range,
    depositMode: 'two_token',
    tokenXAmount: quote.tokenXAmount,
    tokenYAmount: quote.tokenYAmount,
  });
});

test('supports an omitted quote callback', async () => {
  const sdk = sdkWith(async () => quote, async () => preview);
  assert.equal(await prepareAutoFillPosition(sdk, request), preview);
});
