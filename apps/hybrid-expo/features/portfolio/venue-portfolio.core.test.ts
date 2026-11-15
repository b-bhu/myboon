/**
 * Pure tests for the per-venue portfolio contract (#657): fixed tab order,
 * row counting, the empty-state rule (a venue with no orders shows an empty
 * state, not a different tab set) and per-tab fallback copy.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  PORTFOLIO_TAB_KEYS,
  countPortfolioRows,
  isPortfolioTabEmpty,
  portfolioEmptyCopy,
  type PortfolioTabData,
} from './venue-portfolio.contract';

const tab = (overrides: Partial<PortfolioTabData> = {}): PortfolioTabData => ({
  status: 'ready',
  sections: [],
  ...overrides,
});

test('PORTFOLIO_TAB_KEYS is the fixed three-tab set in display order', () => {
  assert.deepEqual([...PORTFOLIO_TAB_KEYS], ['positions', 'orders', 'history']);
});

test('countPortfolioRows sums rows across every section', () => {
  const data = tab({
    sections: [
      { key: 'a', rows: [{ key: '1', title: 'x', value: '1' }, { key: '2', title: 'y', value: '2' }] },
      { key: 'b', label: 'Venue actions', rows: [{ key: '3', title: 'TP/SL', value: 'Set' }] },
    ],
  });
  assert.equal(countPortfolioRows(data), 3);
});

test('isPortfolioTabEmpty is true only when ready with zero rows anywhere', () => {
  assert.equal(isPortfolioTabEmpty(tab()), true);
  assert.equal(
    isPortfolioTabEmpty(tab({ sections: [{ key: 'a', rows: [{ key: '1', title: '', value: '' }] }] })),
    false,
  );
  // Loading / failed / idle never read as empty — they have their own states.
  assert.equal(isPortfolioTabEmpty(tab({ status: 'loading' })), false);
  assert.equal(isPortfolioTabEmpty(tab({ status: 'failed', error: 'x' })), false);
  assert.equal(isPortfolioTabEmpty(tab({ status: 'idle' })), false);
});

test('the orders tab of a venue without orders qualifies as empty, still present', () => {
  // The contract cannot express a missing tab — all three keys always render.
  assert.ok(PORTFOLIO_TAB_KEYS.includes('orders'));
  assert.equal(isPortfolioTabEmpty(tab()), true);
});

test('portfolioEmptyCopy covers every fixed tab', () => {
  for (const key of PORTFOLIO_TAB_KEYS) {
    const copy = portfolioEmptyCopy(key);
    assert.ok(copy.title.length > 0);
    assert.ok(copy.message.length > 0);
  }
});

test('portfolioEmptyCopy returns distinct copy per tab', () => {
  const copies = PORTFOLIO_TAB_KEYS.map((key) => portfolioEmptyCopy(key).title);
  assert.equal(new Set(copies).size, 3);
});
