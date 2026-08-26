import assert from 'node:assert/strict';
import test from 'node:test';
import { createSingleFlightLock, runSingleFlight } from './singleFlight';

test('two withdrawal confirm activations call transferErc20 once', async () => {
  const lock = createSingleFlightLock();
  let transferCalls = 0;
  let releaseTransfer!: () => void;
  const transferPending = new Promise<void>((resolve) => {
    releaseTransfer = resolve;
  });
  const confirm = () => runSingleFlight(lock, async () => {
    transferCalls += 1;
    await transferPending;
  });

  const first = confirm();
  const second = confirm();
  await second;
  assert.equal(transferCalls, 1);
  releaseTransfer();
  await first;
  assert.equal(lock.active, false);
});
