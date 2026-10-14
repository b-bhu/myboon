import assert from 'node:assert/strict';
import test from 'node:test';
import { runFullSignOut, selectMwaDisconnect } from './signOut';

test('Privy preparing with a cached MWA account disconnects MWA before logout', async () => {
  const calls: string[] = [];
  const disconnectMwa = async () => { calls.push('disconnectMwa'); };
  // During Privy hydration useWallet reports source="privy" despite this cached account.
  const selectedDisconnect = selectMwaDisconnect({ hasMwaAccount: true, disconnectMwa });

  await runFullSignOut({
    clearActivation: async () => { calls.push('clearActivation'); },
    disconnectMwa: selectedDisconnect,
    logout: async () => { calls.push('logout'); },
  });

  assert.deepEqual(calls, ['disconnectMwa', 'clearActivation', 'logout']);
});

test('no MWA account skips MWA disconnect', async () => {
  const calls: string[] = [];
  const selectedDisconnect = selectMwaDisconnect({ hasMwaAccount: false, disconnectMwa: async () => { calls.push('disconnectMwa'); } });

  await runFullSignOut({
    clearActivation: async () => { calls.push('clearActivation'); },
    disconnectMwa: selectedDisconnect,
    logout: async () => { calls.push('logout'); },
  });

  assert.deepEqual(calls, ['clearActivation', 'logout']);
});

test('MWA account presence, not wallet source, gates the disconnect', () => {
  const disconnectMwa = async () => {};
  for (const source of ['privy', 'mwa']) {
    const wallet = { source, hasMwaAccount: true, disconnectMwa };
    assert.equal(
      selectMwaDisconnect(wallet),
      disconnectMwa,
      `expected source=${source} to retain disconnect for a cached MWA account`,
    );
  }
  assert.equal(selectMwaDisconnect({ hasMwaAccount: false, disconnectMwa }), undefined);
});

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
