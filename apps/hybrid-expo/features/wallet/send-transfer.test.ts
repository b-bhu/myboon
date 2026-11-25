import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  decodeTransferCheckedInstruction,
} from '@solana/spl-token';
import { Keypair, type Connection, type Transaction } from '@solana/web3.js';
import { SEND_USDC_DECIMALS } from './send-panel.state';
import {
  planSendUsdc,
  sendUsdcOnSolana,
  usdcAssociatedTokenAddress,
  type UsdcTransferInput,
} from './send-transfer';

// Issue #824: one Solana USDC transfer built, signed, sent and confirmed,
// with the signer and the connection mocked — no real funds move here.
//
// The module keeps a retry memory keyed on (sender, recipient, amount), so
// every test below uses its own amount: a cross-test leak would otherwise
// make a later call consult the chain about the previous test's signature.

const SENDER = Keypair.generate().publicKey.toBase58();
const RECIPIENT = Keypair.generate().publicKey.toBase58();
const BALANCE = '1000000';

const RENT_LAMPORTS = 2_040_000;
const BLOCKHASH = { blockhash: 'BH-MOCK', lastValidBlockHeight: 333 };
const WIRE = new Uint8Array([3, 7, 11]);

type SignatureStatusMock = {
  err: unknown;
  confirmationStatus: 'processed' | 'confirmed' | 'finalized' | null;
} | null;

interface WireHandlers {
  recipientAccount: (address: unknown) => unknown;
  rent: (bytes: number) => number;
  blockhash: () => { blockhash: string; lastValidBlockHeight: number };
  signatureStatuses: (signatures: string[]) => SignatureStatusMock[];
  send: (wire: Uint8Array) => string;
  confirm: (strategy: unknown, commitment: string | undefined) => { value: { err: unknown } };
}

interface WireCalls {
  accountInfo: number;
  rent: number;
  blockhash: number;
  signatures: number;
  send: number;
  confirm: number;
}

function fakeWire(overrides: Partial<WireHandlers> = {}): {
  connection: Connection;
  calls: WireCalls;
  handlers: WireHandlers;
} {
  const handlers: WireHandlers = {
    recipientAccount: () => ({}), // the recipient USDC token account exists
    rent: () => RENT_LAMPORTS,
    blockhash: () => BLOCKHASH,
    signatureStatuses: () => [{ err: null, confirmationStatus: 'confirmed' }],
    send: () => 'sig-1',
    confirm: () => ({ value: { err: null } }),
    ...overrides,
  };
  // Handlers are mutated between phases by some tests; the fake closes over
  // the object the caller keeps, so late edits always take effect.
  const calls: WireCalls = { accountInfo: 0, rent: 0, blockhash: 0, signatures: 0, send: 0, confirm: 0 };
  const connection = {
    getAccountInfo: async (address: unknown) => {
      calls.accountInfo += 1;
      return handlers.recipientAccount(address);
    },
    getMinimumBalanceForRentExemption: async (bytes: number) => {
      calls.rent += 1;
      return handlers.rent(bytes);
    },
    getLatestBlockhash: async () => {
      calls.blockhash += 1;
      return handlers.blockhash();
    },
    getSignatureStatuses: async (signatures: string[]) => {
      calls.signatures += 1;
      return { value: handlers.signatureStatuses(signatures) };
    },
    sendRawTransaction: async (wire: Uint8Array) => {
      calls.send += 1;
      return handlers.send(wire);
    },
    confirmTransaction: async (strategy: unknown, commitment?: string) => {
      calls.confirm += 1;
      return handlers.confirm(strategy, commitment);
    },
  } as unknown as Connection;
  return { connection, calls, handlers };
}

const signingHarness = (mode: 'sign' | 'reject' | 'unserializable' = 'sign') => {
  const unsigned: Transaction[] = [];
  const signTransaction = async (transaction: Transaction): Promise<Transaction> => {
    unsigned.push(transaction);
    if (mode === 'reject') throw new Error('user rejected the signature');
    if (mode === 'unserializable') return {} as unknown as Transaction; // no serialize
    return { serialize: () => WIRE } as unknown as Transaction;
  };
  return { signTransaction, unsigned };
};

const baseInput = (amountAtomic: string, connection: Connection): UsdcTransferInput => ({
  fromAddress: SENDER,
  toAddress: RECIPIENT,
  amountAtomic,
  balanceAtomic: BALANCE,
  connection,
});

// A signed-only failure list shape helper: narrows the union for assertions.
const asFailed = (result: { status: string } & Record<string, unknown>) => result as {
  status: 'failed';
  step: string;
  message: string;
  signature?: string;
};

test('confirmed: exactly one transaction is signed and sent', async () => {
  const { connection, calls, handlers } = fakeWire();
  const sentWires: Uint8Array[] = [];
  const confirmStrategies: { blockhash: string; lastValidBlockHeight: number; signature: string }[] = [];
  handlers.send = (wire) => {
    sentWires.push(wire);
    return 'sig-1';
  };
  handlers.confirm = (strategy) => {
    confirmStrategies.push(strategy as (typeof confirmStrategies)[number]);
    return { value: { err: null } };
  };
  const { signTransaction, unsigned } = signingHarness();

  const result = await sendUsdcOnSolana({ ...baseInput('250000', connection), signTransaction });

  assert.deepEqual(result, { status: 'confirmed', signature: 'sig-1' });
  assert.deepEqual(Array.from(sentWires[0]), Array.from(WIRE));
  assert.deepEqual(confirmStrategies[0], { ...BLOCKHASH, signature: 'sig-1' });

  assert.equal(unsigned.length, 1); // signed exactly once
  assert.equal(calls.send, 1); // sent exactly once
  assert.equal(calls.accountInfo, 1); // recipient checked once
  assert.equal(calls.rent, 0); // no rent when the account already exists
  const transaction = unsigned[0];
  assert.ok(transaction.feePayer?.toBase58() === SENDER);
  assert.equal(transaction.recentBlockhash, BLOCKHASH.blockhash);
  assert.equal(transaction.instructions.length, 1, 'transfer only when the recipient account exists');
  const decoded = decodeTransferCheckedInstruction(transaction.instructions[0]);
  assert.equal(decoded.programId.toBase58(), TOKEN_PROGRAM_ID.toBase58());
  assert.equal(decoded.data.amount, 250000n);
  assert.equal(decoded.data.decimals, SEND_USDC_DECIMALS);
  assert.ok(decoded.keys.source.pubkey.equals(usdcAssociatedTokenAddress(SENDER)));
  assert.ok(decoded.keys.destination.pubkey.equals(usdcAssociatedTokenAddress(RECIPIENT)));
  assert.ok(decoded.keys.owner.pubkey.toBase58() === SENDER);
});

test('no recipient token account: create instruction in the same transaction, sender pays', async () => {
  const checkedAddresses: unknown[] = [];
  const rentSizes: number[] = [];
  const { connection, calls } = fakeWire({
    recipientAccount: (address) => {
      checkedAddresses.push(address);
      return null; // the recipient has no USDC token account yet
    },
    rent: (bytes) => {
      rentSizes.push(bytes);
      return RENT_LAMPORTS;
    },
  });
  const { signTransaction, unsigned } = signingHarness();
  const transferInput = baseInput('260000', connection);

  const plan = await planSendUsdc({ ...transferInput, fromAddress: SENDER });
  assert.deepEqual(plan, { needsRecipientAccount: true, rentLamports: RENT_LAMPORTS });
  assert.equal(calls.rent, 1);
  assert.deepEqual(rentSizes, [165], 'rent quoted for a 165-byte token account');

  const result = await sendUsdcOnSolana({ ...transferInput, signTransaction });
  assert.equal(result.status, 'confirmed');
  assert.deepEqual(rentSizes, [165, 165], 'the send re-quotes internally, still for 165 bytes');

  const transaction = unsigned[0];
  assert.equal(transaction.instructions.length, 2);
  const create = transaction.instructions[0];
  assert.ok(create.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID));
  assert.ok(create.keys[0].pubkey.toBase58() === SENDER, 'the sender is the payer of the account creation');
  assert.ok(create.keys[1].pubkey.equals(usdcAssociatedTokenAddress(RECIPIENT)));
  const decoded = decodeTransferCheckedInstruction(transaction.instructions[1]);
  assert.equal(decoded.data.amount, 260000n);
  // The send re-plans internally; both lookups target the recipient's ATA.
  assert.deepEqual(
    checkedAddresses.map((address) => (address as { toBase58(): string }).toBase58()),
    [usdcAssociatedTokenAddress(RECIPIENT).toBase58(), usdcAssociatedTokenAddress(RECIPIENT).toBase58()],
  );
});

test('planSendUsdc: existing recipient account needs nothing', async () => {
  const { connection, calls } = fakeWire();
  assert.deepEqual(
    await planSendUsdc({ ...baseInput('270000', connection), fromAddress: SENDER }),
    { needsRecipientAccount: false, rentLamports: 0 },
  );
  assert.equal(calls.rent, 0, 'no rent quote when the account already exists');
  await assert.rejects(
    planSendUsdc({
      ...baseInput('12.5', connection),
      fromAddress: SENDER,
    }),
    /atomic unsigned-integer string/,
  );
});

test('over-balance: failed at build, the signer and the network are never used', async () => {
  const { connection, calls } = fakeWire();
  const { signTransaction, unsigned } = signingHarness();

  const result = asFailed(await sendUsdcOnSolana({ ...baseInput('1500000', connection), signTransaction }));

  assert.equal(result.status, 'failed');
  assert.equal(result.step, 'build');
  assert.match(result.message, /exceeds the USDC balance/);
  assert.equal(unsigned.length, 0, 'the signer is never called');
  assert.deepEqual(calls, { accountInfo: 0, rent: 0, blockhash: 0, signatures: 0, send: 0, confirm: 0 });

  const malformed = asFailed(
    await sendUsdcOnSolana({ ...baseInput('12.5', connection), signTransaction }),
  );
  assert.equal(malformed.step, 'build');
  assert.deepEqual(calls, { accountInfo: 0, rent: 0, blockhash: 0, signatures: 0, send: 0, confirm: 0 });
});

test('signer rejects: cancelled and nothing is sent', async () => {
  const { connection, calls } = fakeWire();
  const { signTransaction, unsigned } = signingHarness('reject');

  const result = await sendUsdcOnSolana({ ...baseInput('280000', connection), signTransaction });

  assert.deepEqual(result, { status: 'cancelled' });
  assert.equal(unsigned.length, 1);
  assert.equal(calls.send, 0);
  assert.equal(calls.confirm, 0);
});

test('unserializable signed transaction: failed at sign, nothing sent', async () => {
  const { connection, calls } = fakeWire();
  const { signTransaction } = signingHarness('unserializable');

  const result = asFailed(await sendUsdcOnSolana({ ...baseInput('290000', connection), signTransaction }));

  assert.equal(result.status, 'failed');
  assert.equal(result.step, 'sign');
  assert.equal(calls.send, 0);
});

test('send throws: failed at send, no second send in the same call', async () => {
  const { connection, calls } = fakeWire({
    send: () => {
      throw new Error('preflight fee check failed');
    },
  });
  const { signTransaction, unsigned } = signingHarness();

  const result = asFailed(await sendUsdcOnSolana({ ...baseInput('300000', connection), signTransaction }));

  assert.equal(result.status, 'failed');
  assert.equal(result.step, 'send');
  assert.equal(calls.send, 1, 'exactly one send attempt inside the call');
  assert.equal(calls.confirm, 0);
  assert.equal(unsigned.length, 1);
});

test('confirm does not arrive: failed at confirm with the signature; the repeat call returns it once the chain confirms', async () => {
  const { connection, calls, handlers } = fakeWire({
    confirm: () => {
      throw new Error('Transaction was not confirmed in 30.00 seconds');
    },
  });
  const { signTransaction, unsigned } = signingHarness();
  const input = baseInput('310000', connection);

  const first = asFailed(await sendUsdcOnSolana({ ...input, signTransaction }));
  assert.equal(first.status, 'failed');
  assert.equal(first.step, 'confirm');
  assert.equal(first.signature, 'sig-1');
  assert.equal(calls.send, 1);

  // The chain now knows the saved signature is confirmed: resend nothing.
  const statusSignatures: string[][] = [];
  handlers.signatureStatuses = (signatures) => {
    statusSignatures.push(signatures);
    return [{ err: null, confirmationStatus: 'confirmed' }];
  };
  const repeat = await sendUsdcOnSolana({ ...input, signTransaction });

  assert.deepEqual(repeat, { status: 'confirmed', signature: 'sig-1' });
  assert.equal(calls.send, 1, 'no second send when the saved signature confirmed');
  assert.equal(unsigned.length, 1);
  assert.deepEqual(statusSignatures, [['sig-1']]);
});

test('confirm timeout: the repeat call sends again when the chain does not know the signature', async () => {
  const { connection, calls, handlers } = fakeWire();
  const { signTransaction, unsigned } = signingHarness();
  const input = baseInput('400000', connection);
  let rejectConfirm = true;
  handlers.confirm = () => {
    if (rejectConfirm) throw new Error('Transaction was not confirmed in 30.00 seconds');
    return { value: { err: null } };
  };

  const first = asFailed(await sendUsdcOnSolana({ ...input, signTransaction }));
  assert.equal(first.step, 'confirm');

  handlers.signatureStatuses = () => [null]; // the chain never saw it
  handlers.send = () => 'sig-2';
  rejectConfirm = false;
  const repeat = await sendUsdcOnSolana({ ...input, signTransaction });

  assert.deepEqual(repeat, { status: 'confirmed', signature: 'sig-2' });
  assert.equal(calls.send, 2);
  assert.equal(unsigned.length, 2, 'the transfer runs again from the build');
});

test('confirm timeout: a failing chain lookup fails at confirm instead of sending a duplicate', async () => {
  const { connection, calls, handlers } = fakeWire({
    confirm: () => {
      throw new Error('Transaction was not confirmed in 30.00 seconds');
    },
  });
  const { signTransaction } = signingHarness();
  const input = baseInput('500000', connection);

  const first = asFailed(await sendUsdcOnSolana({ ...input, signTransaction }));
  assert.equal(first.step, 'confirm');
  assert.equal(first.signature, 'sig-1');

  handlers.signatureStatuses = () => {
    throw new Error('rpc unavailable');
  };
  const repeat = asFailed(await sendUsdcOnSolana({ ...input, signTransaction }));

  assert.equal(repeat.status, 'failed');
  assert.equal(repeat.step, 'confirm');
  assert.equal(repeat.message, 'rpc unavailable');
  assert.equal(repeat.signature, 'sig-1');
  assert.equal(calls.send, 1, 'the lookup failure must not lead to a duplicate send');
});

test('a repeat after a send failure runs the transfer again from the start', async () => {
  let failSend = true;
  const { connection, calls } = fakeWire({
    send: () => {
      if (failSend) throw new Error('preflight failed');
      return 'sig-1';
    },
  });
  const { signTransaction, unsigned } = signingHarness();
  const input = baseInput('600000', connection);

  const first = asFailed(await sendUsdcOnSolana({ ...input, signTransaction }));
  assert.equal(first.step, 'send');

  failSend = false;
  const repeat = await sendUsdcOnSolana({ ...input, signTransaction });

  assert.deepEqual(repeat, { status: 'confirmed', signature: 'sig-1' });
  assert.equal(calls.send, 2);
  assert.equal(unsigned.length, 2);
});

test('a transaction rejected on chain: failed at confirm with the signature', async () => {
  const { connection, calls, handlers } = fakeWire({
    confirm: () => ({ value: { err: { InstructionError: [0, 'Custom'] } } }),
  });
  const { signTransaction } = signingHarness();

  const first = asFailed(await sendUsdcOnSolana({ ...baseInput('700000', connection), signTransaction }));
  assert.equal(first.step, 'confirm');
  assert.match(first.message, /rejected the transfer/);
  assert.equal(first.signature, 'sig-1');

  // The same rule guards the repeat: the chain says the saved signature
  // errored, so it is not "confirmed" and the transfer is sent again.
  handlers.signatureStatuses = () => [{ err: { InstructionError: [0, 'Custom'] }, confirmationStatus: 'processed' }];
  handlers.send = () => 'sig-2';
  handlers.confirm = () => ({ value: { err: null } });
  const repeat = await sendUsdcOnSolana({ ...baseInput('700000', connection), signTransaction });

  assert.deepEqual(repeat, { status: 'confirmed', signature: 'sig-2' });
  assert.equal(calls.send, 2);
});
