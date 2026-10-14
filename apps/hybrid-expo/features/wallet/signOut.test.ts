import assert from 'node:assert/strict';
import test from 'node:test';
import { runPrivySignOut } from './signOut';

test('Privy logout runs and reports an activation clear failure', async () => {
  const failure = new Error('activation storage unavailable');
  let logoutCalls = 0;
  const reportedErrors: unknown[] = [];

  await runPrivySignOut({
    clearActivation: async () => { throw failure; },
    logout: async () => { logoutCalls += 1; },
    onClearActivationError: (error) => reportedErrors.push(error),
  });

  assert.equal(logoutCalls, 1);
  assert.deepEqual(reportedErrors, [failure]);
});

test('Privy sign-out clears activation before logging out', async () => {
  const calls: string[] = [];

  await runPrivySignOut({
    clearActivation: async () => { calls.push('clearActivation'); },
    logout: async () => { calls.push('logout'); },
  });

  assert.deepEqual(calls, ['clearActivation', 'logout']);
});

test('Privy sign-out propagates a logout failure', async () => {
  const failure = new Error('logout failed');

  await assert.rejects(
    runPrivySignOut({
      clearActivation: async () => {},
      logout: async () => { throw failure; },
    }),
    failure,
  );
});
