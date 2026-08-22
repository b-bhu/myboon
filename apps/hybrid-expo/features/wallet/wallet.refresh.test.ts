import assert from 'node:assert/strict';
import test from 'node:test';
import { notifyWalletDataChanged, subscribeWalletDataChanged } from './wallet.refresh';

test('wallet refresh notifications are scoped, removable, and failure-isolated', () => {
  let calls = 0;
  const stopBroken = subscribeWalletDataChanged(() => { throw new Error('surface unmounted'); });
  const stopCounting = subscribeWalletDataChanged(() => { calls += 1; });

  assert.doesNotThrow(() => notifyWalletDataChanged());
  assert.equal(calls, 1);

  stopBroken();
  stopCounting();
  notifyWalletDataChanged();
  assert.equal(calls, 1);
});
