/**
 * Tests for the remembered Portfolio view choice (issue #840, extended by
 * #871).
 *
 * The switch's contract is that a stored choice survives a reopen only when
 * that view can render: Cards is enabled since #842 and Map since #871, so
 * an unknown value on disk must reopen as Table, and a storage failure must
 * land on Table without ever throwing into the UI.
 *
 * Covers the issues' Verifications: parse of unknown, disabled and enabled
 * values, and read and write when storage throws.
 *
 * Run: pnpm --filter hybrid-expo test:wallet
 *
 * AsyncStorage is a native module and cannot load under `tsx`, so it is
 * replaced in `require.cache` before `portfolio-view.ts` is imported, like
 * `features/chain/activation.test.ts` does. The stub is a real key/value
 * store plus failure switches, not a spy: the read-back assertions below
 * would be vacuous against a stub that only recorded calls.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Backing store, deliberately *outside* the module cache, with the two
 * failure switches the acceptance scenarios need ("storage throws on
 * read", "storage throws on write").
 */
const disk = new Map<string, string>();

let failNextRead = false;
let failNextWrite = false;

const asyncStorageId = require.resolve('@react-native-async-storage/async-storage');
require.cache[asyncStorageId] = {
  id: asyncStorageId,
  filename: asyncStorageId,
  loaded: true,
  exports: {
    __esModule: true,
    default: {
      getItem: async (key: string) => {
        if (failNextRead) {
          failNextRead = false;
          throw new Error('simulated storage read failure');
        }
        return disk.get(key) ?? null;
      },
      setItem: async (key: string, value: string) => {
        if (failNextWrite) {
          failNextWrite = false;
          throw new Error('simulated storage write failure');
        }
        disk.set(key, value);
      },
    },
  } as never,
} as never;

type PortfolioViewModule = typeof import('@/features/wallet/portfolio-view');

const VIEW_MODULE_PATH = require.resolve('@/features/wallet/portfolio-view');

function loadPortfolioView(): PortfolioViewModule {
  delete require.cache[VIEW_MODULE_PATH];
  return require(VIEW_MODULE_PATH) as PortfolioViewModule;
}

beforeEach(() => {
  disk.clear();
  failNextRead = false;
  failNextWrite = false;
});

describe('parsePortfolioView', () => {
  it('accepts the enabled views (map joined in #871)', () => {
    const portfolioView = loadPortfolioView();
    assert.equal(portfolioView.parsePortfolioView('table'), 'table');
    assert.equal(portfolioView.parsePortfolioView('map'), 'map');
    assert.equal(portfolioView.parsePortfolioView('cards'), 'cards');
  });

  it('falls back to table on unknown values and no value', () => {
    const portfolioView = loadPortfolioView();
    assert.equal(portfolioView.parsePortfolioView('grid'), 'table');
    assert.equal(portfolioView.parsePortfolioView('MAP'), 'table');
    assert.equal(portfolioView.parsePortfolioView(''), 'table');
    assert.equal(portfolioView.parsePortfolioView(null), 'table');
  });
});

describe('readPortfolioView / writePortfolioView', () => {
  it('nothing stored reads table', async () => {
    const portfolioView = loadPortfolioView();
    assert.equal(await portfolioView.readPortfolioView(), 'table');
  });

  it('a stored choice survives a reopen', async () => {
    const portfolioView = loadPortfolioView();
    await portfolioView.writePortfolioView('table');
    assert.equal(disk.get('wallet.portfolio.view'), 'table');

    const reopened = loadPortfolioView();
    assert.equal(await reopened.readPortfolioView(), 'table');
  });

  it('a stored view name that is not enabled reopens as table', async () => {
    const portfolioView = loadPortfolioView();
    // No view is disabled today (Map joined in #871), so the unknown-but
    // plausible value stands in for the case a disabled one used to pin.
    disk.set('wallet.portfolio.view', 'grid');

    assert.equal(await portfolioView.readPortfolioView(), 'table');
  });

  it('a stored map choice reopens as map (acceptance: map choice survives a restart)', async () => {
    const portfolioView = loadPortfolioView();
    // #871: 'map' was the disabled stand-in before; now the view renders and
    // the stored choice comes through untouched.
    disk.set('wallet.portfolio.view', 'map');

    assert.equal(await portfolioView.readPortfolioView(), 'map');
  });

  it('a read failure is table, not an error (acceptance: storage throws on read)', async () => {
    const portfolioView = loadPortfolioView();
    disk.set('wallet.portfolio.view', 'table');
    failNextRead = true;

    assert.equal(await portfolioView.readPortfolioView(), 'table');
  });

  it('a write failure resolves and leaves the stored choice intact (acceptance: storage throws on write)', async () => {
    const portfolioView = loadPortfolioView();
    await portfolioView.writePortfolioView('table');

    failNextWrite = true;
    await portfolioView.writePortfolioView('table');

    assert.equal(disk.get('wallet.portfolio.view'), 'table');
  });

  it('the choice is stored under the issue\'s key', async () => {
    const portfolioView = loadPortfolioView();
    await portfolioView.writePortfolioView('table');
    assert.deepEqual([...disk.keys()], ['wallet.portfolio.view']);
  });
});
