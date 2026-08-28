import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { getPhoenixActionRoute } from './takeAction.routes';

describe('getPhoenixActionRoute', () => {
  it('deep-links the Bitcoin story directly to BTC-PERP', () => {
    assert.deepEqual(getPhoenixActionRoute('bitcoin'), {
      pathname: '/markets/phoenix/[symbol]',
      params: { symbol: 'BTC-PERP' },
    });
  });

  it('keeps non-Bitcoin stories on the generic Phoenix route', () => {
    assert.equal(getPhoenixActionRoute('ethereum'), '/markets/phoenix');
    assert.equal(getPhoenixActionRoute(undefined), '/markets/phoenix');
  });

  it('matches the canonical slug without making URL payloads from story content', () => {
    assert.deepEqual(getPhoenixActionRoute(' BITCOIN '), {
      pathname: '/markets/phoenix/[symbol]',
      params: { symbol: 'BTC-PERP' },
    });
    assert.equal(getPhoenixActionRoute('BTC'), '/markets/phoenix');
    assert.equal(getPhoenixActionRoute('bitcoin-news'), '/markets/phoenix');
  });
});
