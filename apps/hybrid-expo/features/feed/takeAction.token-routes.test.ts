import { test } from 'node:test';
import assert from 'node:assert/strict';

import { tokenTradeRoutes } from './takeAction.routes';

// Canonical wrapped-SOL mint (NATIVE_SOL_MINT in features/swap); matches the
// mint shape SpotScreen.tsx:17 gates on.
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const SWAP = (address: string) => ({
  label: 'Swap',
  route: { pathname: '/swap', params: { mode: 'buy', token: address, caller: 'feed' } },
});
const SPOT = (address: string) => ({
  label: 'Spot',
  route: { pathname: '/spot', params: { token: address } },
});
const PERPS = (symbol: string) => ({
  label: 'Perps',
  route: { pathname: '/markets/phoenix/[symbol]', params: { symbol } },
});

test('tokenTradeRoutes always offers Swap first, buying the token with the feed caller', () => {
  assert.deepEqual(tokenTradeRoutes({ address: WSOL_MINT, symbol: 'JUP' })[0], SWAP(WSOL_MINT));
  assert.deepEqual(tokenTradeRoutes({ address: 'So11', symbol: 'jup' })[0], SWAP('So11'));
});

test('tokenTradeRoutes deep-links the spot terminal with the canonical mint (issue #655)', () => {
  assert.deepEqual(tokenTradeRoutes({ address: WSOL_MINT, symbol: 'JUP' }), [
    SWAP(WSOL_MINT),
    SPOT(WSOL_MINT),
  ]);
  // 43-char base58 mints pass the MINT_RE gate too.
  assert.deepEqual(tokenTradeRoutes({ address: 'JUPyi9YhSmpLKQ9uCX2aYnLXwYFLHzuYnP6fTzvLhHC', symbol: 'WIF' })[1], SPOT('JUPyi9YhSmpLKQ9uCX2aYnLXwYFLHzuYnP6fTzvLhHC'));
});

test('tokenTradeRoutes offers no Spot route for a non-mint address (no dead-ending link)', () => {
  // Too short, wrong alphabet and symbol-only strings all stay on swap only.
  assert.deepEqual(tokenTradeRoutes({ address: 'So11', symbol: 'JUP' }), [SWAP('So11')]);
  assert.deepEqual(tokenTradeRoutes({ address: 'A', symbol: 'JUP' }), [SWAP('A')]);
  assert.deepEqual(tokenTradeRoutes({ address: 'BOxO0lI1', symbol: 'JUP' }), [SWAP('BOxO0lI1')]);
});

test('tokenTradeRoutes adds the Phoenix perps route only for SOL, BTC and ETH, last when present', () => {
  assert.deepEqual(tokenTradeRoutes({ address: WSOL_MINT, symbol: 'SOL' }), [SWAP(WSOL_MINT), SPOT(WSOL_MINT), PERPS('SOL-PERP')]);
  assert.deepEqual(tokenTradeRoutes({ address: WSOL_MINT, symbol: 'BTC' }), [SWAP(WSOL_MINT), SPOT(WSOL_MINT), PERPS('BTC-PERP')]);
  // Case-insensitive match, canonical uppercase symbol in the route.
  assert.deepEqual(tokenTradeRoutes({ address: WSOL_MINT, symbol: 'eth' }), [SWAP(WSOL_MINT), SPOT(WSOL_MINT), PERPS('ETH-PERP')]);
  assert.deepEqual(tokenTradeRoutes({ address: WSOL_MINT, symbol: 'Sol' })[2], PERPS('SOL-PERP'));
});

test('tokenTradeRoutes keeps near-misses like WSOL off the perps route (no leading-W strip, exact match)', () => {
  assert.deepEqual(tokenTradeRoutes({ address: WSOL_MINT, symbol: 'WSOL' }), [SWAP(WSOL_MINT), SPOT(WSOL_MINT)]);
  assert.deepEqual(tokenTradeRoutes({ address: WSOL_MINT, symbol: 'SOLS' }), [SWAP(WSOL_MINT), SPOT(WSOL_MINT)]);
  assert.deepEqual(tokenTradeRoutes({ address: WSOL_MINT, symbol: '' }), [SWAP(WSOL_MINT), SPOT(WSOL_MINT)]);
});
