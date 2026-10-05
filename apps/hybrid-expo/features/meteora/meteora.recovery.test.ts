import assert from 'node:assert/strict';
import test from 'node:test';
import { createMeteoraRecoveryCoordinator } from './meteora.recovery';

function fixture() {
  const timers: { run: () => void; cancelled: boolean }[] = [];
  const coordinator = createMeteoraRecoveryCoordinator((run) => {
    const timer = { run, cancelled: false };
    timers.push(timer);
    return () => { timer.cancelled = true; };
  });
  coordinator.setScope('pool-a:wallet-a');
  return { coordinator, timers };
}

test('an empty initial lookup does not block recovery after submitted or syncing execution', () => {
  for (const result of ['submitted', 'syncing']) {
    const { coordinator } = fixture();
    const initial = coordinator.beginAttempt()!;
    // The initial adapter lookup resolved null while the screen stayed mounted.
    assert.equal(coordinator.beginAttempt(), null);
    const execution = coordinator.beginExecution();
    assert.equal(coordinator.beginAttempt(), null, 'never recover during the wallet flow');
    assert.equal(execution.finish(result), true);
    assert.ok(coordinator.beginAttempt(), 'the same mounted screen can now recover its new pending record');
  }
});

test('a delayed recovery callback cannot replace a newer execution state', async () => {
  const { coordinator } = fixture();
  const initial = coordinator.beginAttempt()!;
  let resolve!: () => void;
  const delayed = new Promise<void>((done) => { resolve = done; });
  let state = 'editing';
  const oldCallback = delayed.then(() => {
    if (initial.isCurrent()) state = 'old-confirming';
  });
  const execution = coordinator.beginExecution();
  state = 'awaiting-wallet';
  execution.finish('submitted');
  state = 'submitted';
  resolve();
  await oldCallback;
  assert.equal(state, 'submitted');
  assert.equal(initial.isCurrent(), false, 'stays stale after execution ends');
  assert.ok(coordinator.beginAttempt());
});

test('pending retries release the attempt and run only in the same wallet and pool generation', () => {
  const { coordinator, timers } = fixture();
  let reruns = 0;
  const attempt = coordinator.beginAttempt()!;
  attempt.retry(() => { reruns += 1; });
  timers[0].run();
  assert.equal(reruns, 1);
  const next = coordinator.beginAttempt()!;
  next.retry(() => { reruns += 1; });
  coordinator.setScope('pool-b:wallet-a');
  coordinator.setScope('pool-a:wallet-a');
  timers[1].run();
  assert.equal(reruns, 1, 'returning to the same scope does not revive its old timer');
  assert.ok(coordinator.beginAttempt());
});

test('scope changes, unmount cleanup, and a new execution cancel old callbacks and retry timers', () => {
  for (const action of ['wallet', 'pool', 'unmount', 'execution']) {
    const { coordinator, timers } = fixture();
    const attempt = coordinator.beginAttempt()!;
    let reruns = 0;
    attempt.retry(() => { reruns += 1; });
    if (action === 'wallet') coordinator.setScope('pool-a:wallet-b');
    if (action === 'pool') coordinator.setScope('pool-b:wallet-a');
    if (action === 'unmount') attempt.cancel();
    if (action === 'execution') coordinator.beginExecution();
    assert.equal(attempt.isCurrent(), false);
    timers[0].run(); // Even a queued timer firing after cleanup must be harmless.
    assert.equal(reruns, 0);
    if (action === 'unmount') assert.equal(timers[0].cancelled, true);
  }
});

test('cancelled in-flight lookups can restart, while terminal execution needs no new recovery', () => {
  const { coordinator } = fixture();
  coordinator.beginAttempt()!.cancel();
  assert.ok(coordinator.beginAttempt(), 'dependency cleanup cannot strand an unfinished lookup');
  for (const result of ['confirmed', 'cancelled', 'partial', null]) {
    assert.equal(coordinator.beginExecution().finish(result), false);
  }
  const execution = coordinator.beginExecution();
  coordinator.setScope('pool-a:wallet-b');
  assert.equal(execution.isCurrent(), false, 'old-wallet completion cannot update the new wallet UI');
  assert.equal(execution.finish('submitted'), true, 'the new wallet can perform its own initial recovery lookup');
  assert.ok(coordinator.beginAttempt());
});

test('same-scope dependency cleanup restarts a finished pending poll without clearing a newer attempt', () => {
  const { coordinator, timers } = fixture();
  const first = coordinator.beginAttempt()!;
  first.retry(() => {});
  first.cancel(); // e.g. a newer pool/freshness object rerenders the effect.
  assert.equal(timers[0].cancelled, true);
  const second = coordinator.beginAttempt();
  assert.ok(second, 'cleanup must release the pending retry marker');
  first.cancel(); // Delayed cleanup from an older effect cannot release second.
  assert.equal(coordinator.beginAttempt(), null);
  assert.equal(second.isCurrent(), true);
});
