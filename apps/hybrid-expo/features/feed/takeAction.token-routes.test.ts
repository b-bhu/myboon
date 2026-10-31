import { test } from 'node:test';
import assert from 'node:assert/strict';

import { tokenTradeRoutes } from './takeAction.routes';

const SWAP = (address: string) => ({
  label: 'Swap',
  route: { pathname: '/swap', params: { mode: 'buy', token: address, caller: 'feed' } },
});

const PERPS = (symbol: string) => ({
  label: 'Perps',
  route: { pathname: '/markets/phoenix/[symbol]', params: { symbol } },
});

test('tokenTradeRoutes always offers Swap first, buying the token with the feed caller', () => {
  assert.deepEqual(tokenTradeRoutes({ address: 'JUPmint1111111111111111111111111', symbol: 'JUP' }), [
    SWAP('JUPmint1111111111111111111111111'),
  ]);
  assert.deepEqual(tokenTradeRoutes({ address: 'So11', symbol: 'jup' })[0], SWAP('So11'));
});

test('tokenTradeRoutes adds the Phoenix perps route only for SOL, BTC and ETH', () => {
  assert.deepEqual(tokenTradeRoutes({ address: 'A', symbol: 'SOL' }), [SWAP('A'), PERPS('SOL-PERP')]);
  assert.deepEqual(tokenTradeRoutes({ address: 'A', symbol: 'BTC' }), [SWAP('A'), PERPS('BTC-PERP')]);
  // Case-insensitive match, canonical uppercase symbol in the route.
  assert.deepEqual(tokenTradeRoutes({ address: 'A', symbol: 'eth' }), [SWAP('A'), PERPS('ETH-PERP')]);
  assert.deepEqual(tokenTradeRoutes({ address: 'A', symbol: 'Sol' })[1], PERPS('SOL-PERP'));
});

test('tokenTradeRoutes keeps near-misses like WSOL on swap only (no leading-W strip, exact match)', () => {
  assert.equal(tokenTradeRoutes({ address: 'A', symbol: 'WSOL' }).length, 1);
  assert.equal(tokenTradeRoutes({ address: 'A', symbol: 'SOLS' }).length, 1);
  assert.equal(tokenTradeRoutes({ address: 'A', symbol: 'JUP' }).length, 1);
  assert.equal(tokenTradeRoutes({ address: 'A', symbol: '' }).length, 1);
});