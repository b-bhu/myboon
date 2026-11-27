import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
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

// --- #947: the connection sheet's external disconnect is a full sign-out. ---

type SheetDeps = {
  flow: { linked: 'external' | 'privy' | null };
  dispatch: (event: { type: string; [key: string]: unknown }) => void;
  privy: { isPrivyUser: boolean; disconnect: (disconnectMwa?: () => Promise<unknown>) => Promise<void> };
  solana: { hasMwaAccount: boolean; disconnectMwa?: () => Promise<unknown>; disconnect?: () => Promise<unknown> };
  chain: string;
  deactivate: (chain: string) => Promise<unknown>;
  onClose: () => void;
  busy: boolean;
  setBusy: (value: boolean) => void;
  setActionError: (value: string | null) => void;
  setOtpCode: (value: string) => void;
  setOtpError: (value: string | null) => void;
  setOtpSession: (value: unknown) => void;
  setEmailError: (value: string | null) => void;
};

type SheetDisconnectHook = (deps: SheetDeps) => {
  handleLogout: () => Promise<void>;
  confirmDisconnect: () => Promise<void>;
};

/**
 * Load the real useSheetDisconnect outside React Native: the hook runs in a
 * vm context with the real signOut module wired in (it is dependency-free),
 * so only react's useCallback is shimmed to identity.
 */
function loadSheetDisconnect(): SheetDisconnectHook {
  const transpile = (file: string): string => ts.transpileModule(
    readFileSync(new URL(file, import.meta.url), 'utf8'),
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
      },
    },
  ).outputText;

  const signOutExports: Record<string, unknown> = {};
  // The fixture realms own consoles; forward so host-level mocks see vm logs.
  const sandboxConsole = {
    warn: (...args: unknown[]) => console.warn(...args),
    error: (...args: unknown[]) => console.error(...args),
  };
  runInNewContext(transpile('./signOut.ts'), { exports: signOutExports, console: sandboxConsole }, { filename: 'signOut.fixture.js' });
  const otpExports: Record<string, unknown> = {};
  runInNewContext(transpile('./components/otp-resend.ts'), { exports: otpExports, console: sandboxConsole }, { filename: 'otp-resend.fixture.js' });

  const sheetExports: Record<string, unknown> = {};
  const sandboxRequire = (name: string): unknown => {
    if (name === 'react') return { useCallback: (fn: unknown) => fn };
    if (name === '@/features/wallet/signOut') return signOutExports;
    if (name === '@/features/wallet/components/otp-resend') return otpExports;
    throw new Error(`unexpected require: ${name}`);
  };
  runInNewContext(
    transpile('./components/useSheetDisconnect.ts'),
    { exports: sheetExports, require: sandboxRequire, console: sandboxConsole },
    { filename: 'useSheetDisconnect.fixture.js' },
  );

  return sheetExports.useSheetDisconnect as SheetDisconnectHook;
}

function sheetDeps(overrides: Partial<SheetDeps> = {}): SheetDeps {
  return {
    flow: { linked: 'external' },
    dispatch: () => {},
    privy: { isPrivyUser: false, disconnect: async () => {} },
    solana: { hasMwaAccount: false },
    chain: 'solana',
    deactivate: async () => {},
    onClose: () => {},
    busy: false,
    setBusy: () => {},
    setActionError: () => {},
    setOtpCode: () => {},
    setOtpError: () => {},
    setOtpSession: () => {},
    setEmailError: () => {},
    ...overrides,
  };
}

test('connection sheet external disconnect runs the full sign-out: adapter, solana deactivation, Privy logout', async () => {
  const useSheetDisconnect = loadSheetDisconnect();
  const calls: string[] = [];
  const events: string[] = [];
  let closed = false;
  const { confirmDisconnect } = useSheetDisconnect(sheetDeps({
    dispatch: (event) => { events.push(event.type); },
    privy: { isPrivyUser: false, disconnect: async () => { calls.push('privyLogout'); } },
    solana: { hasMwaAccount: true, disconnectMwa: async () => { calls.push('disconnectMwa'); } },
    deactivate: async (chain) => { calls.push(`deactivate(${chain})`); },
    onClose: () => { closed = true; },
  }));

  await confirmDisconnect();

  assert.deepEqual(calls, ['disconnectMwa', 'deactivate(solana)', 'privyLogout']);
  assert.deepEqual(events, ['disconnected']);
  assert.equal(closed, true);
});

test('connection sheet external disconnect logs out of Privy even when the adapter disconnect fails', async () => {
  const useSheetDisconnect = loadSheetDisconnect();
  const failure = new Error('wallet unavailable');
  const warns: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warns.push(args); };
  let logoutCalls = 0;
  let closed = false;
  const { confirmDisconnect } = useSheetDisconnect(sheetDeps({
    privy: { isPrivyUser: false, disconnect: async () => { logoutCalls += 1; } },
    solana: { hasMwaAccount: true, disconnectMwa: async () => { throw failure; } },
    onClose: () => { closed = true; },
  }));

  try {
    await confirmDisconnect();
  } finally {
    console.warn = originalWarn;
  }

  // The adapter failure is logged, the sign-out completes, and Privy logout ran.
  assert.deepEqual(warns, [['Could not disconnect the external Solana wallet during sign-out.', failure]]);
  assert.equal(logoutCalls, 1);
  assert.equal(closed, true);
});
