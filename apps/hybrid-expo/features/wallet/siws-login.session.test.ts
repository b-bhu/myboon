/**
 * siws-login.session — the #948 behaviour tests.
 *
 * Covers, per the issue:
 * - a wallet sign-in (SIWS login) creates one Privy account keyed to the
 *   external address and never touches the embedded-Solana path
 *   (`waitForWallet()` / `create()` are not on the flow);
 * - opening Polymarket / EVM connect provisions on that same Privy account
 *   with `evm.provision()`, and does not start a new login;
 * - an already-authenticated email user gets the wallet linked
 *   (`useLinkWithSiws`'s `link`), never a second login.
 *
 * The pure paths run against `hooks/siwsAuthentication`; the hook behaviours
 * run under the vm-context fixture loader (`signOut.mwa.test.ts` pattern),
 * with the real `useWalletSetup` / `useChainSigner` transpiled into a sandbox
 * so CI stays renderer-free. Privy SIWS on a device is untested and iOS is
 * out of scope; CI is the gate.
 *
 * Run: pnpm --filter hybrid-expo test:wallet
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import bs58 from 'bs58';

import { POLYMARKET_REQUIREMENT } from '../chain/chain.contract';
import {
  INITIAL_CONNECT_FLOW,
  reduceConnectFlow,
} from './components/connect.flow';
import {
  encodeSiwsSignature,
  pickSiwsMode,
  runSiwsAuthentication,
  SIWS_DOMAIN,
  SIWS_URI,
  type SiwsGenerateMessage,
  type SiwsSubmit,
} from '../../hooks/siwsAuthentication';

const PHANTOM_ADDRESS = 'SiwsPhantom111111111111111111111111111111111';
const EVM_ADDRESS = '0xSiwsEvm00000000000000000000000000000001';
const SIGNATURE_BYTES = new Uint8Array(64).fill(7);

/** A generateMessage that returns a fixed message and records what it saw. */
function recordingGenerateMessage(log: [address: string, from: { domain: string; uri: string }][]): SiwsGenerateMessage {
  return async (args) => {
    log.push([args.wallet.address, args.from]);
    return { message: `MyBoon sign-in for ${args.wallet.address}` };
  };
}

test('pickSiwsMode links only when a Privy session already exists', () => {
  assert.equal(pickSiwsMode(false), 'login');
  assert.equal(pickSiwsMode(true), 'link');
});

test('a wallet sign-in keys one Privy account to the external address and never links', async () => {
  const generated: [address: string, from: { domain: string; uri: string }][] = [];
  const signed: Uint8Array[] = [];
  const submissions: {
    login: { message: string; signature: string }[];
    link: { message: string; signature: string }[];
  } = { login: [], link: [] };
  const login: SiwsSubmit = async (args) => { submissions.login.push(args); };
  const link: SiwsSubmit = async (args) => { submissions.link.push(args); };

  const result = await runSiwsAuthentication({
    address: PHANTOM_ADDRESS,
    authenticated: false,
    signMessage: async (message) => {
      signed.push(new Uint8Array(message));
      return SIGNATURE_BYTES;
    },
    generateMessage: recordingGenerateMessage(generated),
    login,
    link,
  });

  // One account keyed to the Phantom address: the message was generated for
  // it, with the app's own SIWS identity.
  assert.deepEqual(generated, [[PHANTOM_ADDRESS, { domain: SIWS_DOMAIN, uri: SIWS_URI }]]);
  assert.deepEqual(result, { mode: 'login' });

  // The wallet signed exactly the Privy message; the signature arrived the
  // Solana way, base58.
  assert.equal(signed.length, 1);
  assert.equal(Buffer.from(signed[0]).toString('utf8'), `MyBoon sign-in for ${PHANTOM_ADDRESS}`);
  assert.equal(submissions.login.length, 1);
  assert.equal(submissions.link.length, 0);
  assert.deepEqual(bs58.decode(submissions.login[0].signature as string), SIGNATURE_BYTES);
  assert.equal(submissions.login[0].message, `MyBoon sign-in for ${PHANTOM_ADDRESS}`);
});

test('an already-authenticated email user links, and no second login runs', async () => {
  const generated: [address: string, from: { domain: string; uri: string }][] = [];
  const submissions: {
    login: { message: string; signature: string }[];
    link: { message: string; signature: string }[];
  } = { login: [], link: [] };
  const login: SiwsSubmit = async (args) => { submissions.login.push(args); };
  const link: SiwsSubmit = async (args) => { submissions.link.push(args); };

  const result = await runSiwsAuthentication({
    address: PHANTOM_ADDRESS,
    authenticated: true,
    signMessage: async () => SIGNATURE_BYTES,
    generateMessage: recordingGenerateMessage(generated),
    login,
    link,
  });

  assert.deepEqual(result, { mode: 'link' });
  // One account: the wallet joined the current session instead of minting one.
  assert.equal(submissions.link.length, 1);
  assert.equal(submissions.login.length, 0);
  assert.equal(submissions.link[0].message, `MyBoon sign-in for ${PHANTOM_ADDRESS}`);
  assert.equal(submissions.link[0].signature, encodeSiwsSignature(SIGNATURE_BYTES));
});

test('encodeSiwsSignature is base58 over the raw 64 bytes', () => {
  const encoded = encodeSiwsSignature(SIGNATURE_BYTES);
  assert.deepEqual(bs58.decode(encoded), SIGNATURE_BYTES);
  assert.notEqual(encoded, Buffer.from(SIGNATURE_BYTES).toString('base64'));
});

test('an empty address is refused before Privy is contacted', async () => {
  await assert.rejects(
    runSiwsAuthentication({
      address: '',
      authenticated: false,
      signMessage: async () => SIGNATURE_BYTES,
      generateMessage: recordingGenerateMessage([]),
      login: async () => { throw new Error('login should not run'); },
      link: async () => { throw new Error('link should not run'); },
    }),
    { message: 'Sign-In With Solana needs the connected wallet address.' },
  );
});

test('a signature failure propagates and submits nothing', async () => {
  const submissions: unknown[] = [];
  await assert.rejects(
    runSiwsAuthentication({
      address: PHANTOM_ADDRESS,
      authenticated: false,
      signMessage: async () => { throw new Error('Wallet would not sign'); },
      generateMessage: recordingGenerateMessage([]),
      login: async (args) => { submissions.push(args); },
      link: async (args) => { submissions.push(args); },
    }),
    { message: 'Wallet would not sign' },
  );
  assert.deepEqual(submissions, []);
});

// --- Flow machine: a wallet-login open never lands on the fail_setup screen. ---

test('a wallet-login open goes to entry, whose retry never creates the forbidden embedded wallet', () => {
  // The fail_setup retry runs chain-solana wallet setup — `waitForWallet()` /
  // `create()` — which a SIWS account must never do (D57). Entry is the honest
  // step: reconnect links the wallet onto the same account.
  const walletLogin = reduceConnectFlow(INITIAL_CONNECT_FLOW, {
    type: 'open',
    linked: null,
    privyAuthenticated: true,
    hasEmbeddedWallet: false,
    walletLogin: true,
  });
  assert.equal(walletLogin.step.kind, 'entry');

  // Control — an email/Google session with no embedded wallet keeps the
  // fail_setup behaviour this issue must not change.
  const email = reduceConnectFlow(INITIAL_CONNECT_FLOW, {
    type: 'open',
    linked: null,
    privyAuthenticated: true,
    hasEmbeddedWallet: false,
  });
  assert.equal(email.step.kind, 'fail_setup');
});

// --- Fixture loader: the real hooks, transpiled under a sandbox. ---

function transpile(file: string): string {
  return ts.transpileModule(
    readFileSync(new URL(file, import.meta.url), 'utf8'),
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
      },
    },
  ).outputText;
}

type WalletSetupHook = (deps: Record<string, unknown>) => {
  handleExternalWallet: () => Promise<void>;
};

/**
 * Load the real useWalletSetup: react's useCallback is shimmed to identity and
 * expo-haptics is stubbed; connect.flow is the real, dependency-free module.
 */
function loadWalletSetup(): LoadedWalletSetup {
  const sandboxConsole = { warn: () => {}, error: (...args: unknown[]) => console.error(...args) };
  const flowExports: Record<string, unknown> = {};
  runInNewContext(
    transpile('./components/connect.flow.ts'),
    { exports: flowExports, console: sandboxConsole },
    { filename: 'connect.flow.fixture.js' },
  );

  const exports: Record<string, unknown> = {};
  const requireShim = (name: string): unknown => {
    if (name === 'react') return { useCallback: (fn: unknown) => fn };
    if (name === 'expo-haptics') {
      return { notificationAsync: async () => {}, NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' } };
    }
    if (name === '@/features/wallet/components/connect.flow') return flowExports;
    throw new Error(`unexpected require: ${name}`);
  };
  const context: Record<string, unknown> = { exports, require: requireShim, console: sandboxConsole };
  // The sandbox's own Error constructor, so injected failures are native to
  // the realm that catches them (`error instanceof Error` is realm-checked).
  runInNewContext('globalThis.VmRealmError = Error;', context, { filename: 'realm-bootstrap.js' });
  runInNewContext(
    transpile('./components/useWalletSetup.ts'),
    context,
    { filename: 'useWalletSetup.fixture.js' },
  );
  return {
    useWalletSetup: exports.useWalletSetup as WalletSetupHook,
    vmError: context.VmRealmError as unknown as new (message: string) => Error,
  };
}

type LoadedWalletSetup = {
  useWalletSetup: WalletSetupHook;
  vmError: new (message: string) => Error;
};

/**
 * Objects returned by vm-realm code carry the sandbox's Object.prototype, which
 * deepStrictEqual refuses as a different prototype. Tests pass sandbox results
 * through this host-side snapshot so the recorded values are host realm.
 */
function hostSnapshot<T>(value: T): T {
  return { ...(value as object) } as T;
}

type ChainSignerHook = (requirement: Record<string, unknown>) => {
  status: string;
  connect: () => Promise<void>;
};

/**
 * Load the real useChainSigner: every hook/module dependency is a mutable fake
 * except chain.resolution, which runs for real against the real chain.contract.
 */
function loadChainSigner(state: {
  solana: Record<string, unknown>;
  privy: Record<string, unknown>;
  evm: Record<string, unknown>;
  activation: Record<string, unknown>;
  activate: (chain: string) => Promise<void>;
  signerLog: unknown[];
  calls: string[];
}): ChainSignerHook {
  const sandboxConsole = { warn: () => {}, error: (...args: unknown[]) => console.error(...args) };
  const contractExports: Record<string, unknown> = {};
  runInNewContext(
    transpile('../chain/chain.contract.ts'),
    { exports: contractExports, console: sandboxConsole },
    { filename: 'chain.contract.fixture.js' },
  );
  const resolutionExports: Record<string, unknown> = {};
  runInNewContext(
    transpile('../chain/chain.resolution.ts'),
    { exports: resolutionExports, console: sandboxConsole, require: (name: string) => contractExports },
    { filename: 'chain.resolution.fixture.js' },
  );

  const hookState = { isConnecting: false };
  const activate = state.activate;
  const exports: Record<string, unknown> = {};
  const requireShim = (name: string): unknown => {
    if (name === 'react') {
      return {
        useCallback: (fn: unknown) => fn,
        useMemo: (fn: unknown) => (fn as () => unknown)(),
        useState: (init: unknown) => [hookState.isConnecting, (next: boolean) => { hookState.isConnecting = next; }],
      };
    }
    if (name === '@/hooks/useWallet') return { useWallet: () => state.solana };
    if (name === '@/hooks/usePrivyWallet') return { usePrivyWallet: () => state.privy };
    if (name === '@/features/chain/usePrivyEvmWallet') return { usePrivyEvmWallet: () => state.evm };
    if (name === '@/features/chain/activation') {
      return {
        useChainActivation: () => ({
          activation: state.activation,
          isHydrated: true,
          activate,
          deactivate: async () => {},
        }),
      };
    }
    if (name === '@/features/chain/chain.debug') return { logChainState: () => {} };
    if (name === '@/features/chain/chain.signers') {
      return {
        createSolanaSigner: (args: unknown) => { state.signerLog.push(hostSnapshot(args)); return { kind: 'solana', ...(args as object) }; },
        createPrivyEvmSigner: (args: unknown) => { state.signerLog.push(hostSnapshot(args)); return { kind: 'privy-evm', ...(args as object) }; },
      };
    }
    if (name === '@/features/chain/chain.resolution') return resolutionExports;
    throw new Error(`unexpected require: ${name}`);
  };
  runInNewContext(
    transpile('../chain/useChainSigner.ts'),
    { exports, require: requireShim, console: sandboxConsole },
    { filename: 'useChainSigner.fixture.js' },
  );
  return exports.useChainSigner as ChainSignerHook;
}

// --- useWalletSetup: the external path signs in, never provisions Solana. ---

function walletSetupDeps(overrides: {
  connectExternal?: () => Promise<string | null>;
  authenticate?: (input: { address: string }) => Promise<string>;
} = {}) {
  const calls: string[] = [];
  const closedRef = { closed: false };
  const deps = {
    chain: 'solana' as const,
    privy: {
      waitForWallet: async () => { calls.push('privy.waitForWallet'); },
    },
    evm: {
      isProvisioned: false,
      provision: async () => { calls.push('evm.provision'); return EVM_ADDRESS; },
    },
    siws: {
      authenticate: overrides.authenticate ?? (async ({ address }: { address: string }) => {
        calls.push(`siws.authenticate(${address})`);
        return 'login';
      }) as ((input: { address: string }) => Promise<string>) | null,
    },
    solana: {
      connectExternal: overrides.connectExternal ?? (async () => {
        calls.push('connectExternal');
        return PHANTOM_ADDRESS;
      }) as () => Promise<string | null>,
      connect: async () => { calls.push('solana.connect'); },
    },
    activate: async (chain: string) => { calls.push(`activate(${chain})`); },
    onClose: () => { closedRef.closed = true; },
    busy: false,
    setBusy: () => {},
    setActionError: () => {},
  };
  return { calls, closedRef, deps };
}

test('wallet sign-in: connect, SIWS with that address, activate — and never the embedded path', async () => {
  const { useWalletSetup } = loadWalletSetup();
  const events: unknown[] = [];
  const { calls, closedRef, deps } = walletSetupDeps();
  const { handleExternalWallet } = useWalletSetup({ ...deps, dispatch: (event: unknown) => events.push(hostSnapshot(event as { type: string; message?: string })) });

  await handleExternalWallet();

  assert.deepEqual(calls, [
    'connectExternal',
    `siws.authenticate(${PHANTOM_ADDRESS})`,
    'activate(solana)',
  ]);
  assert.deepEqual(events, [
    { type: 'choose_external' },
    { type: 'wallet_setup_succeeded', linked: 'external' },
  ]);
  assert.equal(closedRef.closed, true);
});

test('an email user connecting a wallet runs the same SIWS path, not waitForWallet', async () => {
  const { useWalletSetup } = loadWalletSetup();
  const events: unknown[] = [];
  const { calls, closedRef, deps } = walletSetupDeps();
  // The session choice lives in usePrivySiws (covered by the pure tests);
  // the flow is identical and never touches the embedded-Solana path.
  const { handleExternalWallet } = useWalletSetup({ ...deps, dispatch: (event: unknown) => events.push(hostSnapshot(event as { type: string; message?: string })) });

  await handleExternalWallet();

  assert.deepEqual(calls, [
    'connectExternal',
    `siws.authenticate(${PHANTOM_ADDRESS})`,
    'activate(solana)',
  ]);
  assert.ok(!calls.includes('privy.waitForWallet'));
  assert.ok(!calls.includes('evm.provision'));
  assert.ok(!calls.includes('solana.connect'));
  assert.deepEqual(events[events.length - 1], { type: 'wallet_setup_succeeded', linked: 'external' });
  assert.equal(closedRef.closed, true);
});

test('a cancelled SIWS signature returns to entry without activating', async () => {
  const { useWalletSetup, vmError } = loadWalletSetup();
  const events: { type: string; message?: string }[] = [];
  const { calls, closedRef, deps } = walletSetupDeps({
    authenticate: async () => { throw new vmError('User rejected the request'); },
  });
  const { handleExternalWallet } = useWalletSetup({ ...deps, dispatch: (event: unknown) => events.push(hostSnapshot(event as { type: string; message?: string })) });

  await handleExternalWallet();

  assert.deepEqual(events, [
    { type: 'choose_external' },
    { type: 'external_cancelled' },
  ]);
  assert.ok(!calls.includes('activate(solana)'));
  assert.equal(closedRef.closed, false);
});

test('a failed SIWS sign-in surfaces the message and stays connectable', async () => {
  const { useWalletSetup, vmError } = loadWalletSetup();
  const events: { type: string; message?: string }[] = [];
  const { calls, closedRef, deps } = walletSetupDeps({
    authenticate: async () => { throw new vmError('Privy rejected the signature'); },
  });
  const { handleExternalWallet } = useWalletSetup({ ...deps, dispatch: (event: unknown) => events.push(hostSnapshot(event as { type: string; message?: string })) });

  await handleExternalWallet();

  assert.deepEqual(events, [
    { type: 'choose_external' },
    { type: 'external_failed', message: 'Privy rejected the signature' },
  ]);
  assert.ok(!calls.includes('activate(solana)'));
  assert.equal(closedRef.closed, false);
});

test('an unreadable address never reaches SIWS and is reported, not swallowed', async () => {
  const { useWalletSetup } = loadWalletSetup();
  const events: { type: string; message?: string }[] = [];
  const { calls, deps } = walletSetupDeps({
    connectExternal: async () => null,
  });
  const { handleExternalWallet } = useWalletSetup({ ...deps, dispatch: (event: unknown) => events.push(hostSnapshot(event as { type: string; message?: string })) });

  await handleExternalWallet();

  assert.deepEqual(events, [
    { type: 'choose_external' },
    { type: 'external_failed', message: 'Sign-In With Solana needs the connected wallet address.' },
  ]);
  assert.ok(!calls.some((entry) => entry.startsWith('siws.authenticate')));
  assert.ok(!calls.includes('activate(solana)'));
});

// --- useChainSigner: Polymarket attaches EVM to the same account. ---

function chainSignerState() {
  const calls: string[] = [];
  const signerLog: unknown[] = [];
  const evm: Record<string, unknown> = {
    isPrivyUser: true,
    isProvisioned: false,
    isProvisioning: false,
    needsRecovery: false,
    address: null,
    request: null,
    provision: async () => {
      calls.push('evm.provision');
      evm.isProvisioned = true;
      evm.address = EVM_ADDRESS;
      evm.request = async () => {};
      return EVM_ADDRESS;
    },
  };
  const activation: Record<string, unknown> = { solana: false, evm: false };
  const activate = async (chain: string) => {
    calls.push(`activate(${chain})`);
    activation[chain] = true;
  };
  const state = {
    // A SIWS user: Privy authenticated with no embedded Solana wallet.
    privy: {
      isPrivyUser: true,
      waitForWallet: async () => { calls.push('privy.waitForWallet'); },
    },
    solana: { connected: false, address: null, signMessage: null, isPreparing: false },
    evm,
    activation,
    activate,
    signerLog,
    calls,
  };
  return state;
}

test('opening Polymarket provisions EVM on the same Privy account, with no new login and no Solana setup', async () => {
  const state = chainSignerState();
  const useChainSigner = loadChainSigner(state);

  const before = useChainSigner(POLYMARKET_REQUIREMENT as unknown as Record<string, unknown>);
  assert.equal(before.status, 'needs_connection');

  await before.connect();

  // Exactly the contract: provision on the existing account, record intent.
  assert.deepEqual(state.calls, ['evm.provision', 'activate(evm)']);
  assert.ok(!state.calls.includes('privy.waitForWallet'));

  // Same account, now provisioned: the resolver is ready and the signer is
  // the Privy EVM signer for the address provision() returned.
  const after = useChainSigner(POLYMARKET_REQUIREMENT as unknown as Record<string, unknown>);
  assert.equal(after.status, 'ready');
  assert.deepEqual(
    state.signerLog,
    [{ address: EVM_ADDRESS, chainId: POLYMARKET_REQUIREMENT.chainId, request: state.evm.request }],
  );
});

test('an already-provisioned EVM chain activates without creating anything', async () => {
  const state = chainSignerState();
  state.evm.isProvisioned = true;
  state.evm.address = EVM_ADDRESS;
  state.evm.request = async () => {};
  const useChainSigner = loadChainSigner(state);

  const api = useChainSigner(POLYMARKET_REQUIREMENT as unknown as Record<string, unknown>);
  await api.connect();

  assert.deepEqual(state.calls, ['activate(evm)']);
  const after = useChainSigner(POLYMARKET_REQUIREMENT as unknown as Record<string, unknown>);
  assert.equal(after.status, 'ready');
});
