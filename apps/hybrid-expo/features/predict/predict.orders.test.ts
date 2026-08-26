import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SOURCE = readFileSync(join(__dirname, 'predict.api.ts'), 'utf8');
const PLACE_BET = SOURCE.slice(SOURCE.indexOf('export async function placeBet'), SOURCE.indexOf('// --- CLOB Open Orders ---'));

test('SDK market estimate is performed before final market placement', () => {
  const estimate = PLACE_BET.indexOf('client.estimateMarketPrice');
  const placement = PLACE_BET.indexOf('client.placeMarketOrder');
  assert.ok(estimate >= 0 && placement > estimate);
  assert.match(PLACE_BET, /OrderType\.FOK/);
  assert.match(PLACE_BET, /OrderType\.FAK/);
  assert.match(PLACE_BET, /outsideProtection/);
});

test('accepted SDK response amounts drive shares, price, amount, and payout', () => {
  assert.match(PLACE_BET, /response\.makingAmount/);
  assert.match(PLACE_BET, /response\.takingAmount/);
  assert.match(PLACE_BET, /executionPrice = actualShares > 0 \? actualAmount \/ actualShares/);
  assert.match(PLACE_BET, /expectedPayout: actualShares/);
  assert.match(PLACE_BET, /tradeIds: response\.tradeIds/);
});

test('GTC and GTD limit orders stay on the unified SDK path', () => {
  assert.match(PLACE_BET, /client\.placeLimitOrder/);
  assert.match(PLACE_BET, /params\.orderType === 'GTD'/);
  assert.match(PLACE_BET, /expiration: params\.expiration/);
});
