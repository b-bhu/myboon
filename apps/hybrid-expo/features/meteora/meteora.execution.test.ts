import assert from 'node:assert/strict';
import {
  Keypair,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  type SignatureStatus,
} from '@solana/web3.js';
import {
  createMemoryMeteoraPendingStorage,
  createMeteoraPendingStore,
  createMeteoraExecutionController,
  getMeteoraWalletReadiness,
  type MeteoraExecutionConnection,
  type MeteoraExecutionProgress,
  type NativeMeteoraExecutionRequest,
} from './meteora.execution';
import {
  createMeteoraExecutionController as createWebExecutionController,
  createWebMeteoraPendingStorage,
} from './meteora.execution.web';

const walletKeypair = Keypair.generate();
const poolAddress = Keypair.generate().publicKey.toBase58();

function transaction(requiredSigner?: Keypair): Transaction {
  const keys = requiredSigner
    ? [{ pubkey: requiredSigner.publicKey, isSigner: true, isWritable: true }]
    : [];
  return new Transaction().add(new TransactionInstruction({
    programId: SystemProgram.programId,
    keys,
    data: Buffer.alloc(0),
  }));
}

class FakeConnection implements MeteoraExecutionConnection {
  latestCalls = 0;
  simulateCalls = 0;
  confirmCalls = 0;
  statusCalls = 0;
  blockHeight = 1;
  simulationErrors: unknown[] = [];
  confirmationErrors: unknown[] = [];
  confirmationThrows: unknown[] = [];
  statuses: (SignatureStatus | null)[] = [];
  events: string[] = [];
  simulatedTransactions: Transaction[] = [];

  async getLatestBlockhash() {
    this.latestCalls += 1;
    this.events.push(`blockhash:${this.latestCalls}`);
    return {
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 100 + this.latestCalls,
    };
  }

  async simulateTransaction(value: Transaction) {
    this.simulateCalls += 1;
    this.events.push(`simulate:${this.simulateCalls}`);
    this.simulatedTransactions.push(value);
    return {
      value: {
        err: this.simulationErrors[this.simulateCalls - 1] ?? null,
        logs: [],
      },
    };
  }

  async confirmTransaction() {
    this.confirmCalls += 1;
    this.events.push(`confirm:${this.confirmCalls}`);
    const thrown = this.confirmationThrows[this.confirmCalls - 1];
    if (thrown) throw thrown;
    return {
      value: {
        err: this.confirmationErrors[this.confirmCalls - 1] ?? null,
      },
    };
  }

  async getSignatureStatuses() {
    this.statusCalls += 1;
    return { value: [this.statuses[this.statusCalls - 1] ?? null] };
  }

  async getBlockHeight() {
    return this.blockHeight;
  }
}

function request(
  overrides: Partial<NativeMeteoraExecutionRequest> = {},
): NativeMeteoraExecutionRequest {
  return {
    intentId: `intent-${Math.random()}`,
    network: 'mainnet-beta',
    poolAddress,
    action: 'create_position',
    wallet: {
      connected: true,
      address: walletKeypair.publicKey.toBase58(),
      source: 'mwa',
      signAndSendTransaction: async () => 'signature-default',
    },
    build: async () => ({
      action: 'create_position',
      poolAddress,
      resourceAddress: Keypair.generate().publicKey.toBase58(),
      transactions: [transaction()],
      additionalSigners: [],
    }),
    ...overrides,
  };
}

function controller(connection: FakeConnection) {
  return createMeteoraExecutionController({
    connection,
    pendingStore: createMeteoraPendingStore(createMemoryMeteoraPendingStorage()),
    confirmationTimeoutMs: 20,
    now: () => 10_000,
  });
}

function testReadinessBoundaries(): void {
  assert.equal(getMeteoraWalletReadiness({
    connected: false,
    address: null,
    isPreparing: true,
  }).status, 'wallet_preparing');
  assert.equal(getMeteoraWalletReadiness({
    connected: false,
    address: null,
  }).status, 'disconnected');
  assert.equal(getMeteoraWalletReadiness({
    connected: true,
    address: walletKeypair.publicKey.toBase58(),
  }).status, 'wallet_unsupported');
  assert.equal(getMeteoraWalletReadiness({
    connected: true,
    address: walletKeypair.publicKey.toBase58(),
    signAndSendTransaction: async () => 'signature',
  }).status, 'ready');
}

async function testSequentialHappyPathAndRequiredSigner(): Promise<void> {
  const connection = new FakeConnection();
  const requiredSigner = Keypair.generate();
  const events: string[] = [];
  const progress: MeteoraExecutionProgress[] = [];
  let walletCalls = 0;
  const execution = controller(connection);
  const response = await execution.execute(request({
    wallet: {
      connected: true,
      address: walletKeypair.publicKey.toBase58(),
      signAndSendTransaction: async (tx) => {
        walletCalls += 1;
        events.push(`wallet:${walletCalls}`);
        const requiredSignature = tx.signatures.find(
          (entry) => entry.publicKey.equals(requiredSigner.publicKey),
        );
        if (walletCalls === 1) assert.ok(requiredSignature?.signature);
        return `signature-${walletCalls}`;
      },
    },
    build: async () => ({
      action: 'create_position',
      poolAddress,
      resourceAddress: requiredSigner.publicKey.toBase58(),
      transactions: [transaction(requiredSigner), transaction()],
      additionalSigners: [requiredSigner, Keypair.generate()],
    }),
    onProgress: (value) => progress.push(value),
  }));

  assert.equal(response.status, 'complete');
  assert.deepEqual(response.signatures, ['signature-1', 'signature-2']);
  assert.equal(walletCalls, 2);
  assert.equal(connection.latestCalls, 2);
  assert.equal(connection.simulateCalls, 2);
  assert.equal(connection.confirmCalls, 2);
  assert.notEqual(
    connection.simulatedTransactions[0]?.recentBlockhash,
    connection.simulatedTransactions[1]?.recentBlockhash,
  );
  assert.deepEqual(
    progress.map((value) => value.stage),
    [
      'validation',
      'building',
      'simulating',
      'awaiting_wallet',
      'submitted',
      'confirming',
      'simulating',
      'awaiting_wallet',
      'submitted',
      'confirming',
      'confirmed_syncing',
      'complete',
    ],
  );
  assert.equal(response.explorerUrls[0], 'https://explorer.solana.com/tx/signature-1');
  assert.equal(execution.activeIntentId(), null);
  assert.deepEqual(events, ['wallet:1', 'wallet:2']);
}

async function testSimulationFailureBlocksWallet(): Promise<void> {
  const connection = new FakeConnection();
  connection.simulationErrors = [{ InstructionError: [0, 'Custom'] }];
  let walletCalls = 0;
  const response = await controller(connection).execute(request({
    wallet: {
      connected: true,
      address: walletKeypair.publicKey.toBase58(),
      signAndSendTransaction: async () => {
        walletCalls += 1;
        return 'should-not-send';
      },
    },
  }));

  assert.equal(response.status, 'simulation_failed');
  assert.equal(response.error?.code, 'SIMULATION_FAILED');
  assert.equal(walletCalls, 0);
  assert.equal(connection.confirmCalls, 0);
}

async function testExpiryBeforeBuildAndBlockhashExpiry(): Promise<void> {
  const connection = new FakeConnection();
  let buildCalls = 0;
  const expired = await controller(connection).execute(request({
    expiresAt: 9_999,
    build: async () => {
      buildCalls += 1;
      return {
        action: 'create_position',
        poolAddress,
        resourceAddress: null,
        transactions: [transaction()],
        additionalSigners: [],
      };
    },
  }));
  assert.equal(expired.status, 'expired_before_submit');
  assert.equal(expired.error?.code, 'PREVIEW_EXPIRED');
  assert.equal(buildCalls, 0);

  const blockhashConnection = new FakeConnection();
  blockhashConnection.blockHeight = 10_000;
  let walletCalls = 0;
  const blockhashExpired = await controller(blockhashConnection).execute(request({
    wallet: {
      connected: true,
      address: walletKeypair.publicKey.toBase58(),
      signAndSendTransaction: async () => {
        walletCalls += 1;
        return 'should-not-send';
      },
    },
  }));
  assert.equal(blockhashExpired.status, 'expired_before_submit');
  assert.equal(blockhashExpired.error?.code, 'BLOCKHASH_EXPIRED');
  assert.equal(walletCalls, 0);
}

async function testWalletRejectionAndMissingSigner(): Promise<void> {
  const rejected = await controller(new FakeConnection()).execute(request({
    wallet: {
      connected: true,
      address: walletKeypair.publicKey.toBase58(),
      signAndSendTransaction: async () => {
        throw Object.assign(new Error('User rejected request'), { code: 4001 });
      },
    },
  }));
  assert.equal(rejected.status, 'wallet_rejected');
  assert.equal(rejected.error?.code, 'WALLET_REJECTED');

  const required = Keypair.generate();
  let walletCalls = 0;
  const missing = await controller(new FakeConnection()).execute(request({
    wallet: {
      connected: true,
      address: walletKeypair.publicKey.toBase58(),
      signAndSendTransaction: async () => {
        walletCalls += 1;
        return 'should-not-send';
      },
    },
    build: async () => ({
      action: 'create_position',
      poolAddress,
      resourceAddress: required.publicKey.toBase58(),
      transactions: [transaction(required)],
      additionalSigners: [],
    }),
  }));
  assert.equal(missing.status, 'failed');
  assert.equal(missing.error?.code, 'MISSING_REQUIRED_SIGNER');
  assert.equal(walletCalls, 0);
}

async function testPartialCompletion(): Promise<void> {
  const connection = new FakeConnection();
  connection.simulationErrors = [null, { InstructionError: [0, 'Custom'] }];
  let walletCalls = 0;
  const response = await controller(connection).execute(request({
    wallet: {
      connected: true,
      address: walletKeypair.publicKey.toBase58(),
      signAndSendTransaction: async () => {
        walletCalls += 1;
        return `partial-signature-${walletCalls}`;
      },
    },
    build: async () => ({
      action: 'create_position',
      poolAddress,
      resourceAddress: Keypair.generate().publicKey.toBase58(),
      transactions: [transaction(), transaction()],
      additionalSigners: [],
    }),
  }));

  assert.equal(response.status, 'partially_complete');
  assert.equal(response.error?.code, 'SIMULATION_FAILED');
  assert.deepEqual(response.signatures, ['partial-signature-1']);
  assert.equal(walletCalls, 1);
  assert.equal(response.pending?.status, 'partially_complete');
}

async function testUnknownConfirmationNeverResendsAndCanRecover(): Promise<void> {
  const connection = new FakeConnection();
  connection.confirmationThrows = [new Error('RPC timeout')];
  connection.statuses = [null, null];
  const store = createMeteoraPendingStore(createMemoryMeteoraPendingStorage());
  let walletCalls = 0;
  const execution = createMeteoraExecutionController({
    connection,
    pendingStore: store,
    confirmationTimeoutMs: 20,
    now: () => 10_000,
  });
  const first = await execution.execute(request({
    intentId: 'unknown-intent',
    network: 'devnet',
    wallet: {
      connected: true,
      address: walletKeypair.publicKey.toBase58(),
      signAndSendTransaction: async () => {
        walletCalls += 1;
        return 'unknown-signature';
      },
    },
  }));
  assert.equal(first.status, 'confirmation_unknown');
  assert.equal(first.error?.code, 'CONFIRMATION_UNKNOWN');
  assert.equal(walletCalls, 1);
  assert.equal(first.explorerUrls[0]?.endsWith('?cluster=devnet'), true);

  const saved = await store.get('unknown-intent');
  assert.ok(saved);
  const recovered = await execution.recover(saved, {
    walletAddress: walletKeypair.publicKey.toBase58(),
    network: 'devnet',
  });
  assert.equal(recovered.status, 'confirmation_unknown');
  assert.equal(walletCalls, 1);
  assert.equal(connection.latestCalls, 1);
}

async function testDuplicateAndWalletScopeGuards(): Promise<void> {
  const connection = new FakeConnection();
  let releaseBuild: () => void = () => {};
  const waitForBuild = new Promise<void>((resolve) => {
    releaseBuild = resolve;
  });
  const execution = controller(connection);
  const firstPromise = execution.execute(request({
    intentId: 'active-first',
    build: async () => {
      await waitForBuild;
      return {
        action: 'create_position',
        poolAddress,
        resourceAddress: null,
        transactions: [transaction()],
        additionalSigners: [],
      };
    },
  }));
  for (let attempt = 0; attempt < 20 && execution.activeIntentId() === null; attempt += 1) {
    await Promise.resolve();
  }
  assert.equal(execution.activeIntentId(), 'active-first');
  const duplicate = await execution.execute(request({ intentId: 'active-second' }));
  assert.equal(duplicate.error?.code, 'DUPLICATE_ACTIVE_INTENT');
  releaseBuild();
  await firstPromise;

  const changedConnection = new FakeConnection();
  const changed = await createMeteoraExecutionController({
    connection: changedConnection,
    pendingStore: createMeteoraPendingStore(createMemoryMeteoraPendingStorage()),
    now: () => 10_000,
    getWalletSnapshot: () => ({
      connected: true,
      address: Keypair.generate().publicKey.toBase58(),
      signAndSendTransaction: async () => 'wrong-wallet',
    }),
  }).execute(request());
  assert.equal(changed.error?.code, 'WALLET_CHANGED');
  assert.equal(changedConnection.simulateCalls, 0);
}

async function testCrossControllerMutexAndPreparedPersistence(): Promise<void> {
  const connection = new FakeConnection();
  const store = createMeteoraPendingStore(createMemoryMeteoraPendingStorage());
  let releaseBuild: () => void = () => {};
  const waitForBuild = new Promise<void>((resolve) => {
    releaseBuild = resolve;
  });
  const firstController = createMeteoraExecutionController({
    connection,
    pendingStore: store,
    now: () => 10_000,
  });
  const secondController = createMeteoraExecutionController({
    connection,
    pendingStore: store,
    now: () => 10_000,
  });
  const firstPromise = firstController.execute(request({
    intentId: 'cross-controller-first',
    build: async () => {
      await waitForBuild;
      return {
        action: 'create_position',
        poolAddress,
        resourceAddress: Keypair.generate().publicKey.toBase58(),
        transactions: [transaction()],
        additionalSigners: [],
      };
    },
  }));
  await Promise.resolve();
  const duplicate = await secondController.execute(request({
    intentId: 'cross-controller-second',
  }));
  assert.equal(duplicate.error?.code, 'DUPLICATE_ACTIVE_INTENT');
  releaseBuild();
  await firstPromise;

  const preparedStore = createMeteoraPendingStore(createMemoryMeteoraPendingStorage());
  const preparedController = createMeteoraExecutionController({
    connection: new FakeConnection(),
    pendingStore: preparedStore,
    now: () => 20_000,
  });
  let sawPrepared = false;
  const preparedResult = await preparedController.execute(request({
    intentId: 'prepared-before-wallet',
    wallet: {
      connected: true,
      address: walletKeypair.publicKey.toBase58(),
      signAndSendTransaction: async () => {
        const saved = await preparedStore.get('prepared-before-wallet');
        sawPrepared = saved?.status === 'prepared'
          && saved.steps.length === 0
          && !!saved.resourceAddress;
        throw Object.assign(new Error('User rejected request'), { code: 4001 });
      },
    },
  }));
  assert.equal(sawPrepared, true);
  assert.equal(preparedResult.status, 'wallet_rejected');
  assert.equal(await preparedStore.get('prepared-before-wallet'), null);
}

async function testPreparedRecoveryUsesResourceReconciliation(): Promise<void> {
  const store = createMeteoraPendingStore(createMemoryMeteoraPendingStorage());
  const prepared = {
    version: 1 as const,
    intentId: 'prepared-recovery',
    planId: 'plan',
    previewId: 'preview',
    walletAddress: walletKeypair.publicKey.toBase58(),
    network: 'mainnet-beta' as const,
    poolAddress,
    action: 'create_position',
    resourceAddress: Keypair.generate().publicKey.toBase58(),
    status: 'prepared' as const,
    totalSteps: 1,
    steps: [],
    createdAt: 1,
    updatedAt: 1,
    expiresAt: null,
    preparedBlockhash: 'prepared-blockhash',
    preparedLastValidBlockHeight: 100,
  };
  await store.save(prepared);
  const execution = createMeteoraExecutionController({
    connection: new FakeConnection(),
    pendingStore: store,
    now: () => 20_000,
  });
  const found = await execution.recover(prepared, {
    walletAddress: prepared.walletAddress,
    network: prepared.network,
    reconcile: async () => true,
  });
  assert.equal(found.status, 'complete');
  assert.equal(await store.get(prepared.intentId), null);

  const expiredPrepared = {
    ...prepared,
    intentId: 'prepared-expired',
    resourceAddress: Keypair.generate().publicKey.toBase58(),
  };
  await store.save(expiredPrepared);
  const expiredConnection = new FakeConnection();
  expiredConnection.blockHeight = 101;
  const expired = await createMeteoraExecutionController({
    connection: expiredConnection,
    pendingStore: store,
    now: () => 20_000,
  }).recover(expiredPrepared, {
    walletAddress: expiredPrepared.walletAddress,
    network: expiredPrepared.network,
    reconcile: async () => false,
  });
  assert.equal(expired.status, 'expired_before_submit');
  assert.equal(expired.error?.code, 'BLOCKHASH_EXPIRED');
  assert.equal(await store.get(expiredPrepared.intentId), null);
}

async function testPersistenceFailureBlocksWalletPrompt(): Promise<void> {
  let walletCalls = 0;
  const response = await createMeteoraExecutionController({
    connection: new FakeConnection(),
    pendingStore: {
      async get() { return null; },
      async list() { return []; },
      async save() { throw new Error('storage unavailable'); },
      async remove() {},
      async findActive() { return null; },
    },
    now: () => 20_000,
  }).execute(request({
    wallet: {
      connected: true,
      address: walletKeypair.publicKey.toBase58(),
      signAndSendTransaction: async () => {
        walletCalls += 1;
        return 'must-not-send';
      },
    },
  }));
  assert.equal(response.error?.code, 'PENDING_PERSIST_FAILED');
  assert.equal(walletCalls, 0);
}

async function testStartedMultiStepPlanContinuesPastPreviewExpiry(): Promise<void> {
  const connection = new FakeConnection();
  let now = 10_000;
  let walletCalls = 0;
  const execution = createMeteoraExecutionController({
    connection,
    pendingStore: createMeteoraPendingStore(createMemoryMeteoraPendingStorage()),
    now: () => now,
  });
  const response = await execution.execute(request({
    expiresAt: 10_100,
    wallet: {
      connected: true,
      address: walletKeypair.publicKey.toBase58(),
      signAndSendTransaction: async () => {
        walletCalls += 1;
        if (walletCalls === 1) now = 20_000;
        return `expiry-signature-${walletCalls}`;
      },
    },
    build: async () => ({
      action: 'create_position',
      poolAddress,
      resourceAddress: Keypair.generate().publicKey.toBase58(),
      transactions: [transaction(), transaction()],
      additionalSigners: [],
    }),
  }));
  assert.equal(response.status, 'complete');
  assert.equal(walletCalls, 2);
}

async function testOnchainFailureAndSyncPending(): Promise<void> {
  const failedConnection = new FakeConnection();
  failedConnection.confirmationErrors = [{ InstructionError: [0, 'Custom'] }];
  const failed = await controller(failedConnection).execute(request());
  assert.equal(failed.status, 'onchain_failed');
  assert.equal(failed.error?.code, 'ONCHAIN_FAILED');
  assert.equal(failed.signatures.length, 1);

  const syncPending = await controller(new FakeConnection()).execute(request({
    reconcile: async () => false,
  }));
  assert.equal(syncPending.status, 'confirmed_syncing');
  assert.equal(syncPending.error?.code, 'SYNC_PENDING');
  assert.ok(syncPending.pending);
}

// Web reuses the same engine as native (browser wallets satisfy the same
// signAndSendTransaction/Connection shape) — only the pending-storage backend
// differs, so this exercises the real happy path through the web entry point
// rather than a separate "guarded/unsupported" contract.
async function testWebExecutionRunsTheRealEngine(): Promise<void> {
  const connection = new FakeConnection();
  const web = createWebExecutionController({
    connection,
    pendingStore: createMeteoraPendingStore(createMemoryMeteoraPendingStorage()),
  });

  const response = await web.execute(request({
    build: async () => ({
      action: 'create_position',
      poolAddress,
      resourceAddress: null,
      transactions: [transaction()],
      additionalSigners: [],
    }),
  }));
  assert.equal(response.status, 'complete');
  assert.equal(response.signatures.length, 1);
}

async function testWebPendingStorageIsBrowserBacked(): Promise<void> {
  const store = new Map<string, string>();
  const fakeLocalStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
  };
  const originalWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = { localStorage: fakeLocalStorage };
  try {
    const storage = createWebMeteoraPendingStorage();
    await storage.setItem('k', 'v');
    assert.equal(await storage.getItem('k'), 'v');
    assert.equal(store.get('k'), 'v');
    await storage.removeItem('k');
    assert.equal(await storage.getItem('k'), null);
  } finally {
    (globalThis as { window?: unknown }).window = originalWindow;
  }
}

async function main(): Promise<void> {
  testReadinessBoundaries();
  await testSequentialHappyPathAndRequiredSigner();
  await testSimulationFailureBlocksWallet();
  await testExpiryBeforeBuildAndBlockhashExpiry();
  await testWalletRejectionAndMissingSigner();
  await testPartialCompletion();
  await testUnknownConfirmationNeverResendsAndCanRecover();
  await testDuplicateAndWalletScopeGuards();
  await testCrossControllerMutexAndPreparedPersistence();
  await testPreparedRecoveryUsesResourceReconciliation();
  await testPersistenceFailureBlocksWalletPrompt();
  await testStartedMultiStepPlanContinuesPastPreviewExpiry();
  await testOnchainFailureAndSyncPending();
  await testWebExecutionRunsTheRealEngine();
  await testWebPendingStorageIsBrowserBacked();
  console.log('Meteora mobile execution tests passed');
}

void main();
