import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { BTC_DEMO_EVENTS, isBitcoinPerpSymbol } from './btc-demo-events';

describe('BTC_DEMO_EVENTS', () => {
  it('keeps ten image-backed annotations deliberately separated', () => {
    assert.equal(BTC_DEMO_EVENTS.length, 10);
    const positions = BTC_DEMO_EVENTS.map((event) => Number(event.chartPosition));
    positions.forEach((position, index) => {
      assert.ok(position >= 0 && position <= 1);
      assert.match(String(BTC_DEMO_EVENTS[index].imageUrl), /^https:\/\//);
      if (index > 0) assert.ok(position - positions[index - 1] >= 0.08);
    });
  });
});

describe('isBitcoinPerpSymbol', () => {
  it('matches BTC chart symbols without annotating other markets', () => {
    assert.equal(isBitcoinPerpSymbol('BTC-PERP'), true);
    assert.equal(isBitcoinPerpSymbol('btc'), true);
    assert.equal(isBitcoinPerpSymbol('SOL-PERP'), false);
  });
});
