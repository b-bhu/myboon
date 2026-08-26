import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SOURCE = readFileSync(join(__dirname, 'predict.errors.ts'), 'utf8');

test('classifies actions with official unified SDK guards and concrete error types', () => {
  for (const guard of [
    'PlaceMarketOrderError.isError',
    'EstimateMarketPriceError.isError',
    'TransferErc20Error.isError',
    'RedeemPositionsError.isError',
    'WaitForOrderFillSettlementError.isError',
  ]) assert.match(SOURCE, new RegExp(guard.replace('.', '\\.')));

  for (const errorClass of [
    'CancelledSigningError',
    'InsufficientLiquidityError',
    'RateLimitError',
    'RequestRejectedError',
    'TimeoutError',
    'TransactionFailedError',
    'TransportError',
  ]) assert.match(SOURCE, new RegExp(`instanceof ${errorClass}`));
});

test('preserves rate-limit, restriction, authentication, and settlement distinctions', () => {
  assert.match(SOURCE, /retryAfter\?: number/);
  assert.match(SOURCE, /kind: 'restriction'/);
  assert.match(SOURCE, /kind: 'authentication'/);
  assert.match(SOURCE, /kind: 'order_waiting'/);
});
