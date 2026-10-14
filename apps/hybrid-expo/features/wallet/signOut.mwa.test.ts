import assert from 'node:assert/strict';
import test from 'node:test';
import { runFullSignOut } from './signOut';

test('full sign-out disconnects MWA and logs out of Privy', async () => {
  const state: { mwaConnected: boolean; mwaAddress: string | null; privyAuthenticated: boolean } = {
    mwaConnected: true,
    mwaAddress: 'mwa-address',
    privyAuthenticated: true,
  };
  const calls: string[] = [];

  await runFullSignOut({
    clearActivation: async () => { calls.push('clearActivation'); },
    disconnectMwa: async () => {
      calls.push('disconnectMwa');
      state.mwaConnected = false;
      state.mwaAddress = null;
    },
    logout: async () => {
      calls.push('logout');
      state.privyAuthenticated = false;
    },
  });

  assert.deepEqual(calls, ['disconnectMwa', 'clearActivation', 'logout']);
  assert.deepEqual(state, { mwaConnected: false, mwaAddress: null, privyAuthenticated: false });
});

test('full sign-out logs MWA disconnect failure and still logs out of Privy', async () => {
  const failure = new Error('wallet unavailable');
  const state: { mwaConnected: boolean; mwaAddress: string | null; privyAuthenticated: boolean } = {
    mwaConnected: true,
    mwaAddress: 'mwa-address',
    privyAuthenticated: true,
  };
  let logoutCalls = 0;
  const reportedErrors: unknown[] = [];

  await runFullSignOut({
    clearActivation: async () => {},
    disconnectMwa: async () => {
      // The native hook clears its local cached account before invoking MWA.
      state.mwaConnected = false;
      state.mwaAddress = null;
      throw failure;
    },
    logout: async () => {
      logoutCalls += 1;
      state.privyAuthenticated = false;
    },
    onMwaDisconnectError: (error) => reportedErrors.push(error),
  });

  assert.equal(logoutCalls, 1);
  assert.deepEqual(reportedErrors, [failure]);
  assert.deepEqual(state, { mwaConnected: false, mwaAddress: null, privyAuthenticated: false });
});
