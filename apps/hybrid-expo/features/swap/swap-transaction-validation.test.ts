import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  SWAP_PROGRAM_IDS,
  SWAP_VALIDATION_REFUSAL_CODES,
  finalizeWalletSignedSwapTransaction,
  simulateAndVerifySwap,
  type SwapSimulationResponse,
  validateSwapTransaction,
  validateSwapTransactionForSigning,
  verifySwapSimulation,
} from './swap-transaction-validation';

const wallet = Keypair.generate();
const other = Keypair.generate();
const inputMint = Keypair.generate().publicKey;
const outputMint = Keypair.generate().publicKey;

class FakeConnection {
  tables = new Map<string, AddressLookupTableAccount>();
  accountInfo = new Map<string, unknown>();
  simulation: SwapSimulationResponse | null = null;
  async getAddressLookupTable(address: PublicKey) {
    return { value: this.tables.get(address.toBase58()) ?? null };
  }
  async getAccountInfo(address: PublicKey) {
    return this.accountInfo.get(address.toBase58()) ?? null;
  }
  async simulateTransaction() {
    if (!this.simulation) throw new Error('Simulation is not configured');
    return this.simulation;
  }
}

function tx(instructions: TransactionInstruction[], payer = wallet): VersionedTransaction {
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions,
  }).compileToV0Message();
  return new VersionedTransaction(message);
}

function encoded(transaction: VersionedTransaction): string {
  return Buffer.from(transaction.serialize()).toString('base64');
}

function reviewed(overrides: Partial<{ inputMint: string; outputMint: string; inputAmountAtomic: string; minimumOutAmountAtomic: string }> = {}) {
  return {
    inputMint: inputMint.toBase58(),
    outputMint: outputMint.toBase58(),
    inputAmountAtomic: '100',
    minimumOutAmountAtomic: '90',
    maximumNetworkCostLamports: '1000',
    ...overrides,
  };
}

function validate(transaction: VersionedTransaction, connection = new FakeConnection(), overrides = {}) {
  return validateSwapTransaction({
    serializedTransaction: encoded(transaction),
    activeWallet: wallet.publicKey,
    reviewed: reviewed(overrides),
    connection,
  });
}

const jupiterInstruction = () => new TransactionInstruction({
  programId: new PublicKey(SWAP_PROGRAM_IDS.jupiterV6),
  keys: [],
  data: Buffer.from([1, 2, 3]),
});

test('refuses a wrong fee payer', async () => {
  const result = await validate(tx([jupiterInstruction()], other));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, SWAP_VALIDATION_REFUSAL_CODES.WRONG_FEE_PAYER);
});

test('refuses an unresolved address lookup table', async () => {
  const tableKey = Keypair.generate().publicKey;
  const addressTable = new AddressLookupTableAccount({
    key: tableKey,
    state: {
      deactivationSlot: BigInt('18446744073709551615'),
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      addresses: [Keypair.generate().publicKey],
    },
  });
  const connection = new FakeConnection();
  const message = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [new TransactionInstruction({ programId: new PublicKey(SWAP_PROGRAM_IDS.jupiterV6), keys: [{ pubkey: addressTable.state.addresses[0], isSigner: false, isWritable: true }], data: Buffer.alloc(0) })],
  }).compileToV0Message([addressTable]);
  const result = await validate(new VersionedTransaction(message), connection);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, SWAP_VALIDATION_REFUSAL_CODES.UNRESOLVED_ADDRESS_LOOKUP_TABLE);
});

test('refuses a disallowed program', async () => {
  const result = await validate(tx([new TransactionInstruction({ programId: Keypair.generate().publicKey, keys: [], data: Buffer.alloc(0) })]));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, SWAP_VALIDATION_REFUSAL_CODES.DISALLOWED_PROGRAM);
});

for (const [name, opcode] of [['Approve', 4], ['ApproveChecked', 13], ['SetAuthority', 6]] as const) {
  test(`refuses token ${name}`, async () => {
    const tokenAccount = Keypair.generate().publicKey;
    const instruction = new TransactionInstruction({
      programId: new PublicKey(SWAP_PROGRAM_IDS.token),
      keys: [{ pubkey: tokenAccount, isSigner: false, isWritable: true }, { pubkey: other.publicKey, isSigner: false, isWritable: false }],
      data: Buffer.from([opcode]),
    });
    const result = await validate(tx([instruction]));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, SWAP_VALIDATION_REFUSAL_CODES.UNSAFE_TOKEN_INSTRUCTION);
  });
}

test('refuses unsafe close account destination', async () => {
  const result = await validate(tx([new TransactionInstruction({
    programId: new PublicKey(SWAP_PROGRAM_IDS.token),
    keys: [
      { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true },
      { pubkey: other.publicKey, isSigner: false, isWritable: true },
      { pubkey: wallet.publicKey, isSigner: true, isWritable: false },
    ],
    data: Buffer.from([9]),
  })]));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, SWAP_VALIDATION_REFUSAL_CODES.UNSAFE_CLOSE_ACCOUNT);
});

test('refuses an unexpected required signer', async () => {
  const result = await validate(tx([new TransactionInstruction({
    programId: new PublicKey(SWAP_PROGRAM_IDS.jupiterV6),
    keys: [{ pubkey: other.publicKey, isSigner: true, isWritable: false }],
    data: Buffer.alloc(0),
  })]));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, SWAP_VALIDATION_REFUSAL_CODES.UNEXPECTED_REQUIRED_SIGNER);
});

test('refuses a compute-budget priority fee above the reviewed network bound', async () => {
  const transaction = tx([
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000_000 }),
    jupiterInstruction(),
  ]);
  const result = await validateSwapTransaction({
    serializedTransaction: encoded(transaction),
    activeWallet: wallet.publicKey,
    reviewed: { ...reviewed(), maximumNetworkCostLamports: '100' },
    connection: new FakeConnection(),
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, SWAP_VALIDATION_REFUSAL_CODES.COMPUTE_BUDGET_FEE_EXCEEDS_REVIEW);
});

test('simulation failure and insufficient output are deterministic', () => {
  const failed = verifySwapSimulation({ value: { err: { InstructionError: [0, 'Custom'] } } }, { activeWallet: wallet.publicKey, reviewed: reviewed() });
  assert.equal(failed.ok, false);
  if (!failed.ok) assert.equal(failed.code, SWAP_VALIDATION_REFUSAL_CODES.SIMULATION_FAILED);

  const insufficient = verifySwapSimulation({
    value: {
      err: null,
      preBalances: [1000],
      postBalances: [900],
      preTokenBalances: [
        { accountIndex: 0, mint: inputMint.toBase58(), owner: wallet.publicKey.toBase58(), amount: '100' },
        { accountIndex: 1, mint: outputMint.toBase58(), owner: wallet.publicKey.toBase58(), amount: '10' },
      ],
      postTokenBalances: [
        { accountIndex: 0, mint: inputMint.toBase58(), owner: wallet.publicKey.toBase58(), amount: '0' },
        { accountIndex: 1, mint: outputMint.toBase58(), owner: wallet.publicKey.toBase58(), amount: '50' },
      ],
    },
  }, { activeWallet: wallet.publicKey, reviewed: reviewed({ minimumOutAmountAtomic: '90' }) });
  assert.equal(insufficient.ok, false);
  if (!insufficient.ok) assert.equal(insufficient.code, SWAP_VALIDATION_REFUSAL_CODES.SIMULATED_OUTPUT_BELOW_MINIMUM);
});

test('simulation infrastructure outage is distinguished from a simulated failure', async () => {
  const result = await simulateAndVerifySwap(
    tx([jupiterInstruction()]),
    { simulateTransaction: async () => { throw new Error('RPC unavailable'); } },
    { activeWallet: wallet.publicKey, reviewed: reviewed() },
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, SWAP_VALIDATION_REFUSAL_CODES.SIMULATION_DATA_UNAVAILABLE);
});

test('accepts an allowlisted Jupiter transaction and exact simulation output', async () => {
  const sourceTokenAccount = Keypair.generate().publicKey;
  const outputTokenAccount = Keypair.generate().publicKey;
  const inputVault = Keypair.generate().publicKey;
  const outputVault = Keypair.generate().publicKey;
  const connection = new FakeConnection();
  connection.accountInfo.set(sourceTokenAccount.toBase58(), { mint: inputMint.toBase58(), owner: wallet.publicKey.toBase58(), amountAtomic: '100' });
  connection.accountInfo.set(outputTokenAccount.toBase58(), { mint: outputMint.toBase58(), owner: wallet.publicKey.toBase58(), amountAtomic: '10' });
  connection.accountInfo.set(inputVault.toBase58(), { mint: inputMint.toBase58(), owner: Keypair.generate().publicKey.toBase58(), amountAtomic: '1000' });
  connection.accountInfo.set(outputVault.toBase58(), { mint: outputMint.toBase58(), owner: Keypair.generate().publicKey.toBase58(), amountAtomic: '1000' });
  const opaqueJupiterInstruction = new TransactionInstruction({
    programId: new PublicKey(SWAP_PROGRAM_IDS.jupiterV6),
    keys: [
      { pubkey: sourceTokenAccount, isSigner: false, isWritable: true },
      { pubkey: outputTokenAccount, isSigner: false, isWritable: true },
      { pubkey: inputVault, isSigner: false, isWritable: true },
      { pubkey: outputVault, isSigner: false, isWritable: true },
    ],
    data: Buffer.from([1, 2, 3]),
  });
  const result = await validate(tx([
    ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }),
    opaqueJupiterInstruction,
    new TransactionInstruction({
      programId: new PublicKey(SWAP_PROGRAM_IDS.token),
      keys: [
        { pubkey: sourceTokenAccount, isSigner: false, isWritable: true },
        { pubkey: outputTokenAccount, isSigner: false, isWritable: true },
        { pubkey: wallet.publicKey, isSigner: true, isWritable: false },
      ],
      data: Buffer.concat([Buffer.from([3]), Buffer.from([100, 0, 0, 0, 0, 0, 0, 0])]),
    }),
  ], wallet), connection);
  assert.equal(result.ok, true);
  const simulation = verifySwapSimulation({
    value: {
      err: null,
      preBalances: [1_000_000],
      postBalances: [999_000],
      // This is the shape returned by web3.js/RPC, not the normalized helper
      // shape: the atomic string lives under uiTokenAmount.amount.
      preTokenBalances: [
        { accountIndex: 0, mint: inputMint.toBase58(), owner: wallet.publicKey.toBase58(), uiTokenAmount: { amount: '100' } },
        { accountIndex: 1, mint: outputMint.toBase58(), owner: wallet.publicKey.toBase58(), uiTokenAmount: { amount: '10' } },
      ],
      postTokenBalances: [
        { accountIndex: 0, mint: inputMint.toBase58(), owner: wallet.publicKey.toBase58(), uiTokenAmount: { amount: '0' } },
        { accountIndex: 1, mint: outputMint.toBase58(), owner: wallet.publicKey.toBase58(), uiTokenAmount: { amount: '110' } },
      ],
    },
  }, { activeWallet: wallet.publicKey, reviewed: reviewed({ minimumOutAmountAtomic: '90' }) });
  assert.equal(simulation.ok, true);
  if (simulation.ok) {
    assert.equal(simulation.outputAmountAtomic, '100');
    assert.equal(simulation.balanceChanges.nativeLamports.delta, '-1000');
    assert.equal(simulation.balanceChanges.tokens.find((entry) => entry.mint === outputMint.toBase58())?.deltaAtomic, '100');
  }
});

test('simulation bounds cover SOL-to-token and token-to-SOL reviews', () => {
  const sol = 'So11111111111111111111111111111111111111112';
  const solToToken = verifySwapSimulation({
    value: {
      err: null,
      preBalances: [1_000],
      postBalances: [880],
      preTokenBalances: [{ accountIndex: 1, mint: outputMint.toBase58(), owner: wallet.publicKey.toBase58(), amount: '0' }],
      postTokenBalances: [{ accountIndex: 1, mint: outputMint.toBase58(), owner: wallet.publicKey.toBase58(), amount: '95' }],
    },
  }, { activeWallet: wallet.publicKey, reviewed: { inputMint: sol, outputMint: outputMint.toBase58(), inputAmountAtomic: '100', maximumInputAmountAtomic: '100', maximumNetworkCostLamports: '30', minimumOutAmountAtomic: '90' } });
  assert.equal(solToToken.ok, true);

  const tokenToSol = verifySwapSimulation({
    value: {
      err: null,
      preBalances: [500],
      postBalances: [580],
      preTokenBalances: [{ accountIndex: 1, mint: inputMint.toBase58(), owner: wallet.publicKey.toBase58(), amount: '100' }],
      postTokenBalances: [{ accountIndex: 1, mint: inputMint.toBase58(), owner: wallet.publicKey.toBase58(), amount: '0' }],
    },
  }, { activeWallet: wallet.publicKey, reviewed: { inputMint: inputMint.toBase58(), outputMint: sol, inputAmountAtomic: '100', maximumInputAmountAtomic: '100', maximumNetworkCostLamports: '20', minimumOutAmountAtomic: '90' } });
  assert.equal(tokenToSol.ok, true);

  const overInput = verifySwapSimulation({
    value: {
      err: null,
      preBalances: [500],
      postBalances: [500],
      preTokenBalances: [{ accountIndex: 1, mint: inputMint.toBase58(), owner: wallet.publicKey.toBase58(), amount: '200' }],
      postTokenBalances: [{ accountIndex: 1, mint: inputMint.toBase58(), owner: wallet.publicKey.toBase58(), amount: '0' }],
    },
  }, { activeWallet: wallet.publicKey, reviewed: { inputMint: inputMint.toBase58(), outputMint: sol, inputAmountAtomic: '100', maximumInputAmountAtomic: '100', maximumNetworkCostLamports: '20', minimumOutAmountAtomic: '90' } });
  assert.equal(overInput.ok, false);
  if (!overInput.ok) assert.equal(overInput.code, SWAP_VALIDATION_REFUSAL_CODES.SIMULATED_INPUT_OUTSIDE_BOUNDS);
});

test('simulation bounds native SOL loss for SPL-to-SPL swaps', () => {
  const result = verifySwapSimulation({
    value: {
      err: null,
      preBalances: [20_000_000_000],
      postBalances: [10_000_000_000],
      preTokenBalances: [
        { accountIndex: 1, mint: inputMint.toBase58(), owner: wallet.publicKey.toBase58(), amount: '100' },
        { accountIndex: 2, mint: outputMint.toBase58(), owner: wallet.publicKey.toBase58(), amount: '0' },
      ],
      postTokenBalances: [
        { accountIndex: 1, mint: inputMint.toBase58(), owner: wallet.publicKey.toBase58(), amount: '0' },
        { accountIndex: 2, mint: outputMint.toBase58(), owner: wallet.publicKey.toBase58(), amount: '100' },
      ],
    },
  }, {
    activeWallet: wallet.publicKey,
    reviewed: {
      ...reviewed(),
      maximumInputAmountAtomic: '100',
      maximumNetworkCostLamports: '5000',
    },
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, SWAP_VALIDATION_REFUSAL_CODES.SIMULATED_NETWORK_COST_OUTSIDE_BOUNDS);
});

test('fails closed when reviewed output ownership evidence is absent', async () => {
  const result = await validate(tx([jupiterInstruction()]), new FakeConnection(), { inputMint: 'So11111111111111111111111111111111111111112' });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, SWAP_VALIDATION_REFUSAL_CODES.OUTPUT_ACCOUNT_NOT_OWNED);
});

test('fails closed when token account RPC evidence is unavailable', async () => {
  const sourceTokenAccount = Keypair.generate().publicKey;
  const outputTokenAccount = Keypair.generate().publicKey;
  const tokenTransfer = new TransactionInstruction({
    programId: new PublicKey(SWAP_PROGRAM_IDS.token),
    keys: [
      { pubkey: sourceTokenAccount, isSigner: false, isWritable: true },
      { pubkey: outputTokenAccount, isSigner: false, isWritable: true },
      { pubkey: wallet.publicKey, isSigner: true, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from([3]), Buffer.from([100, 0, 0, 0, 0, 0, 0, 0])]),
  });
  const result = await validate(tx([tokenTransfer]));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, SWAP_VALIDATION_REFUSAL_CODES.INPUT_MINT_MISMATCH);
});

test('public signing adapter enforces the reviewed writable-account set', async () => {
  const source = Keypair.generate().publicKey;
  const destination = Keypair.generate().publicKey;
  const connection = new FakeConnection();
  connection.accountInfo.set(source.toBase58(), { mint: inputMint.toBase58(), owner: wallet.publicKey.toBase58(), amountAtomic: '100' });
  connection.accountInfo.set(destination.toBase58(), { mint: outputMint.toBase58(), owner: wallet.publicKey.toBase58(), amountAtomic: '10' });
  const transfer = new TransactionInstruction({
    programId: new PublicKey(SWAP_PROGRAM_IDS.token),
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: wallet.publicKey, isSigner: true, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from([3]), Buffer.from([100, 0, 0, 0, 0, 0, 0, 0])]),
  });
  const transactionBase64 = encoded(tx([transfer]));
  const accepted = await validateSwapTransactionForSigning({
    transactionBase64, walletAddress: wallet.publicKey, inputMint: inputMint.toBase58(), outputMint: outputMint.toBase58(),
    inAmountAtomic: '100', minimumOutAmountAtomic: '90', connection,
  });
  assert.equal(accepted.transaction.message.version, 0);
  await assert.rejects(
    validateSwapTransactionForSigning({
      transactionBase64, walletAddress: wallet.publicKey, inputMint: inputMint.toBase58(), outputMint: outputMint.toBase58(),
      inAmountAtomic: '100', minimumOutAmountAtomic: '90', expectedWritableAccounts: [], connection,
    }),
    (error: unknown) => error instanceof Error && 'code' in error && (error as { code: string }).code === SWAP_VALIDATION_REFUSAL_CODES.UNEXPECTED_WRITABLE_ACCOUNT,
  );
});

test('production adapter rejects writable accounts with unknown RPC evidence', async () => {
  const source = Keypair.generate().publicKey;
  const destination = Keypair.generate().publicKey;
  const unknownRouteState = Keypair.generate().publicKey;
  const connection = new FakeConnection();
  connection.accountInfo.set(source.toBase58(), { mint: inputMint.toBase58(), owner: wallet.publicKey.toBase58(), amountAtomic: '100' });
  connection.accountInfo.set(destination.toBase58(), { mint: outputMint.toBase58(), owner: wallet.publicKey.toBase58(), amountAtomic: '10' });
  const transaction = tx([
    new TransactionInstruction({ programId: new PublicKey(SWAP_PROGRAM_IDS.jupiterV6), keys: [{ pubkey: unknownRouteState, isSigner: false, isWritable: true }], data: Buffer.alloc(0) }),
    new TransactionInstruction({
      programId: new PublicKey(SWAP_PROGRAM_IDS.token),
      keys: [{ pubkey: source, isSigner: false, isWritable: true }, { pubkey: destination, isSigner: false, isWritable: true }, { pubkey: wallet.publicKey, isSigner: true, isWritable: false }],
      data: Buffer.concat([Buffer.from([3]), Buffer.from([100, 0, 0, 0, 0, 0, 0, 0])]),
    }),
  ]);
  await assert.rejects(
    validateSwapTransactionForSigning({ transactionBase64: encoded(transaction), walletAddress: wallet.publicKey, inputMint: inputMint.toBase58(), outputMint: outputMint.toBase58(), inAmountAtomic: '100', minimumOutAmountAtomic: '90', connection }),
    (error: unknown) => error instanceof Error && 'code' in error && (error as { code: string }).code === SWAP_VALIDATION_REFUSAL_CODES.UNKNOWN_WRITABLE_ACCOUNT,
  );
});

test('accepts a program-owned Jupiter intermediary vault with a third mint', async () => {
  const source = Keypair.generate().publicKey;
  const destination = Keypair.generate().publicKey;
  const unexpectedVault = Keypair.generate().publicKey;
  const unexpectedMint = Keypair.generate().publicKey;
  const connection = new FakeConnection();
  connection.accountInfo.set(source.toBase58(), { mint: inputMint.toBase58(), owner: wallet.publicKey.toBase58(), amountAtomic: '100' });
  connection.accountInfo.set(destination.toBase58(), { mint: outputMint.toBase58(), owner: wallet.publicKey.toBase58(), amountAtomic: '10' });
  connection.accountInfo.set(unexpectedVault.toBase58(), { mint: unexpectedMint.toBase58(), owner: Keypair.generate().publicKey.toBase58(), amountAtomic: '1000' });
  const transaction = tx([
    new TransactionInstruction({ programId: new PublicKey(SWAP_PROGRAM_IDS.jupiterV6), keys: [{ pubkey: source, isSigner: false, isWritable: true }, { pubkey: destination, isSigner: false, isWritable: true }, { pubkey: unexpectedVault, isSigner: false, isWritable: true }], data: Buffer.alloc(0) }),
    new TransactionInstruction({
      programId: new PublicKey(SWAP_PROGRAM_IDS.token),
      keys: [{ pubkey: source, isSigner: false, isWritable: true }, { pubkey: destination, isSigner: false, isWritable: true }, { pubkey: wallet.publicKey, isSigner: true, isWritable: false }],
      data: Buffer.concat([Buffer.from([3]), Buffer.from([100, 0, 0, 0, 0, 0, 0, 0])]),
    }),
  ]);
  const validated = await validateSwapTransactionForSigning({ transactionBase64: encoded(transaction), walletAddress: wallet.publicKey, inputMint: inputMint.toBase58(), outputMint: outputMint.toBase58(), inAmountAtomic: '100', minimumOutAmountAtomic: '90', connection });
  assert.equal(validated.transaction.message.version, 0);
});

test('revalidates and simulates a safe wallet-reconstructed transaction', async () => {
  const source = Keypair.generate().publicKey;
  const destination = Keypair.generate().publicKey;
  const connection = new FakeConnection();
  connection.accountInfo.set(source.toBase58(), { mint: inputMint.toBase58(), owner: wallet.publicKey.toBase58(), amountAtomic: '100' });
  connection.accountInfo.set(destination.toBase58(), { mint: outputMint.toBase58(), owner: wallet.publicKey.toBase58(), amountAtomic: '10' });
  connection.simulation = {
    value: {
      err: null,
      preBalances: [1_000],
      postBalances: [999],
      preTokenBalances: [
        { accountIndex: 1, mint: inputMint.toBase58(), owner: wallet.publicKey.toBase58(), amount: '100' },
        { accountIndex: 2, mint: outputMint.toBase58(), owner: wallet.publicKey.toBase58(), amount: '10' },
      ],
      postTokenBalances: [
        { accountIndex: 1, mint: inputMint.toBase58(), owner: wallet.publicKey.toBase58(), amount: '0' },
        { accountIndex: 2, mint: outputMint.toBase58(), owner: wallet.publicKey.toBase58(), amount: '100' },
      ],
    },
  };
  const transfer = new TransactionInstruction({
    programId: new PublicKey(SWAP_PROGRAM_IDS.token),
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: wallet.publicKey, isSigner: true, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from([3]), Buffer.from([100, 0, 0, 0, 0, 0, 0, 0])]),
  });
  const reviewedTransaction = tx([jupiterInstruction(), transfer]);
  const walletTransaction = tx([jupiterInstruction(), transfer]);
  walletTransaction.sign([wallet]);

  const finalized = await finalizeWalletSignedSwapTransaction({
    reviewedTransactionBase64: encoded(reviewedTransaction),
    signedTransaction: walletTransaction,
    walletAddress: wallet.publicKey,
    inputMint: inputMint.toBase58(),
    outputMint: outputMint.toBase58(),
    inputAmountAtomic: '100',
    maximumInputAmountAtomic: '100',
    maximumNetworkCostLamports: '10',
    minimumOutAmountAtomic: '90',
    connection,
  });
  assert.deepEqual(finalized.message.serialize(), walletTransaction.message.serialize());
});

test('rejects a wallet-reconstructed transaction that misses the reviewed output', async () => {
  const source = Keypair.generate().publicKey;
  const destination = Keypair.generate().publicKey;
  const connection = new FakeConnection();
  connection.accountInfo.set(source.toBase58(), { mint: inputMint.toBase58(), owner: wallet.publicKey.toBase58(), amountAtomic: '100' });
  connection.accountInfo.set(destination.toBase58(), { mint: outputMint.toBase58(), owner: wallet.publicKey.toBase58(), amountAtomic: '10' });
  connection.simulation = {
    value: {
      err: null,
      preBalances: [1_000],
      postBalances: [999],
      preTokenBalances: [
        { accountIndex: 1, mint: inputMint.toBase58(), owner: wallet.publicKey.toBase58(), amount: '100' },
        { accountIndex: 2, mint: outputMint.toBase58(), owner: wallet.publicKey.toBase58(), amount: '10' },
      ],
      postTokenBalances: [
        { accountIndex: 1, mint: inputMint.toBase58(), owner: wallet.publicKey.toBase58(), amount: '0' },
        { accountIndex: 2, mint: outputMint.toBase58(), owner: wallet.publicKey.toBase58(), amount: '50' },
      ],
    },
  };
  const transfer = new TransactionInstruction({
    programId: new PublicKey(SWAP_PROGRAM_IDS.token),
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: wallet.publicKey, isSigner: true, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from([3]), Buffer.from([100, 0, 0, 0, 0, 0, 0, 0])]),
  });
  const reviewedTransaction = tx([jupiterInstruction(), transfer]);
  const walletTransaction = tx([jupiterInstruction(), transfer]);
  walletTransaction.sign([wallet]);

  await assert.rejects(
    finalizeWalletSignedSwapTransaction({
      reviewedTransactionBase64: encoded(reviewedTransaction),
      signedTransaction: walletTransaction,
      walletAddress: wallet.publicKey,
      inputMint: inputMint.toBase58(),
      outputMint: outputMint.toBase58(),
      inputAmountAtomic: '100',
      maximumInputAmountAtomic: '100',
      maximumNetworkCostLamports: '10',
      minimumOutAmountAtomic: '90',
      connection,
    }),
    (error: unknown) => error instanceof Error && 'code' in error && (error as { code: string }).code === SWAP_VALIDATION_REFUSAL_CODES.SIMULATED_OUTPUT_BELOW_MINIMUM,
  );
});

test('allows a Jupiter intermediary mint only when simulation proves no wallet loss', async () => {
  const source = Keypair.generate().publicKey;
  const destination = Keypair.generate().publicKey;
  const unexpectedWalletAccount = Keypair.generate().publicKey;
  const unexpectedMint = Keypair.generate().publicKey;
  const connection = new FakeConnection();
  connection.accountInfo.set(source.toBase58(), { mint: inputMint.toBase58(), owner: wallet.publicKey.toBase58(), amountAtomic: '100' });
  connection.accountInfo.set(destination.toBase58(), { mint: outputMint.toBase58(), owner: wallet.publicKey.toBase58(), amountAtomic: '10' });
  connection.accountInfo.set(unexpectedWalletAccount.toBase58(), { mint: unexpectedMint.toBase58(), owner: wallet.publicKey.toBase58(), amountAtomic: '1' });
  const transaction = tx([
    new TransactionInstruction({
      programId: new PublicKey(SWAP_PROGRAM_IDS.jupiterV6),
      keys: [
        { pubkey: source, isSigner: false, isWritable: true },
        { pubkey: destination, isSigner: false, isWritable: true },
        { pubkey: unexpectedWalletAccount, isSigner: false, isWritable: true },
      ],
      data: Buffer.alloc(0),
    }),
    new TransactionInstruction({
      programId: new PublicKey(SWAP_PROGRAM_IDS.token),
      keys: [
        { pubkey: source, isSigner: false, isWritable: true },
        { pubkey: destination, isSigner: false, isWritable: true },
        { pubkey: wallet.publicKey, isSigner: true, isWritable: false },
      ],
      data: Buffer.concat([Buffer.from([3]), Buffer.from([100, 0, 0, 0, 0, 0, 0, 0])]),
    }),
  ]);
  const validated = await validateSwapTransactionForSigning({ transactionBase64: encoded(transaction), walletAddress: wallet.publicKey, inputMint: inputMint.toBase58(), outputMint: outputMint.toBase58(), inAmountAtomic: '100', minimumOutAmountAtomic: '90', connection });
  assert.equal(validated.transaction.message.version, 0);

  const simulation = (unexpectedAfter: string) => verifySwapSimulation({
    value: {
      err: null,
      preBalances: [1_000],
      postBalances: [999],
      preTokenBalances: [
        { accountIndex: 1, mint: inputMint.toBase58(), owner: wallet.publicKey.toBase58(), amount: '100' },
        { accountIndex: 2, mint: outputMint.toBase58(), owner: wallet.publicKey.toBase58(), amount: '10' },
        { accountIndex: 3, mint: unexpectedMint.toBase58(), owner: wallet.publicKey.toBase58(), amount: '1' },
      ],
      postTokenBalances: [
        { accountIndex: 1, mint: inputMint.toBase58(), owner: wallet.publicKey.toBase58(), amount: '0' },
        { accountIndex: 2, mint: outputMint.toBase58(), owner: wallet.publicKey.toBase58(), amount: '100' },
        { accountIndex: 3, mint: unexpectedMint.toBase58(), owner: wallet.publicKey.toBase58(), amount: unexpectedAfter },
      ],
    },
  }, { activeWallet: wallet.publicKey, reviewed: reviewed() });

  assert.equal(simulation('1').ok, true);
  const loss = simulation('0');
  assert.equal(loss.ok, false);
  if (!loss.ok) assert.equal(loss.code, SWAP_VALIDATION_REFUSAL_CODES.UNEXPECTED_WALLET_BALANCE_DECREASE);
});

test('production adapter rejects route state with absent or non-executable owner', async () => {
  for (const ownerInfo of [null, { executable: false }]) {
    const source = Keypair.generate().publicKey;
    const destination = Keypair.generate().publicKey;
    const routeState = Keypair.generate().publicKey;
    const routeOwner = Keypair.generate().publicKey;
    const connection = new FakeConnection();
    connection.accountInfo.set(source.toBase58(), { mint: inputMint.toBase58(), owner: wallet.publicKey.toBase58(), amountAtomic: '100' });
    connection.accountInfo.set(destination.toBase58(), { mint: outputMint.toBase58(), owner: wallet.publicKey.toBase58(), amountAtomic: '10' });
    connection.accountInfo.set(routeState.toBase58(), { owner: routeOwner });
    if (ownerInfo) connection.accountInfo.set(routeOwner.toBase58(), ownerInfo);
    const transaction = tx([
      new TransactionInstruction({ programId: new PublicKey(SWAP_PROGRAM_IDS.jupiterV6), keys: [{ pubkey: routeState, isSigner: false, isWritable: true }, { pubkey: routeOwner, isSigner: false, isWritable: false }], data: Buffer.alloc(0) }),
      new TransactionInstruction({
        programId: new PublicKey(SWAP_PROGRAM_IDS.token),
        keys: [{ pubkey: source, isSigner: false, isWritable: true }, { pubkey: destination, isSigner: false, isWritable: true }, { pubkey: wallet.publicKey, isSigner: true, isWritable: false }],
        data: Buffer.concat([Buffer.from([3]), Buffer.from([100, 0, 0, 0, 0, 0, 0, 0])]),
      }),
    ]);
    await assert.rejects(
      validateSwapTransactionForSigning({ transactionBase64: encoded(transaction), walletAddress: wallet.publicKey, inputMint: inputMint.toBase58(), outputMint: outputMint.toBase58(), inAmountAtomic: '100', minimumOutAmountAtomic: '90', connection }),
      (error: unknown) => error instanceof Error && 'code' in error && (error as { code: string }).code === SWAP_VALIDATION_REFUSAL_CODES.UNVERIFIED_ROUTE_STATE,
    );
  }
});
