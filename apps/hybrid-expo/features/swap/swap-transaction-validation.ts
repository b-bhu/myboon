import {
  PublicKey,
  VersionedTransaction,
  type AddressLookupTableAccount,
  type MessageAddressTableLookup,
} from '@solana/web3.js';
import nacl from 'tweetnacl';

/** Program ids which may appear as top-level instructions in a Jupiter v6 swap. */
export const SWAP_PROGRAM_IDS = {
  jupiterV6: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  /** OKX router program returned by Jupiter Swap V2 Meta-Aggregator orders. */
  okxRouter: 'proVF4pMXVaYqmy4NjniPh4pqKNfMmsihgd4wdkCX3u',
  token: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  token2022: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxu',
  associatedToken: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  computeBudget: 'ComputeBudget111111111111111111111111111111',
  system: '11111111111111111111111111111111',
} as const;

const ALLOWED_PROGRAMS: Set<string> = new Set(Object.values(SWAP_PROGRAM_IDS));
const TOKEN_PROGRAMS: Set<string> = new Set([SWAP_PROGRAM_IDS.token, SWAP_PROGRAM_IDS.token2022]);
const NATIVE_SOL_MINT = 'So11111111111111111111111111111111111111112';

/** Stable refusal values. Do not use provider error strings as branch keys. */
export const SWAP_VALIDATION_REFUSAL_CODES = {
  MALFORMED_TRANSACTION: 'MALFORMED_TRANSACTION',
  UNSUPPORTED_TRANSACTION_VERSION: 'UNSUPPORTED_TRANSACTION_VERSION',
  UNRESOLVED_ADDRESS_LOOKUP_TABLE: 'UNRESOLVED_ADDRESS_LOOKUP_TABLE',
  WRONG_FEE_PAYER: 'WRONG_FEE_PAYER',
  DISALLOWED_PROGRAM: 'DISALLOWED_PROGRAM',
  UNEXPECTED_REQUIRED_SIGNER: 'UNEXPECTED_REQUIRED_SIGNER',
  UNEXPECTED_WRITABLE_ACCOUNT: 'UNEXPECTED_WRITABLE_ACCOUNT',
  UNSAFE_TOKEN_INSTRUCTION: 'UNSAFE_TOKEN_INSTRUCTION',
  UNSAFE_CLOSE_ACCOUNT: 'UNSAFE_CLOSE_ACCOUNT',
  INPUT_MINT_MISMATCH: 'INPUT_MINT_MISMATCH',
  OUTPUT_MINT_MISMATCH: 'OUTPUT_MINT_MISMATCH',
  INPUT_AMOUNT_MISMATCH: 'INPUT_AMOUNT_MISMATCH',
  OUTPUT_ACCOUNT_NOT_OWNED: 'OUTPUT_ACCOUNT_NOT_OWNED',
  UNEXPECTED_WALLET_BALANCE_DECREASE: 'UNEXPECTED_WALLET_BALANCE_DECREASE',
  UNKNOWN_WRITABLE_ACCOUNT: 'UNKNOWN_WRITABLE_ACCOUNT',
  UNVERIFIED_ROUTE_STATE: 'UNVERIFIED_ROUTE_STATE',
  SIMULATION_FAILED: 'SIMULATION_FAILED',
  SIMULATED_OUTPUT_BELOW_MINIMUM: 'SIMULATED_OUTPUT_BELOW_MINIMUM',
  SIMULATED_INPUT_OUTSIDE_BOUNDS: 'SIMULATED_INPUT_OUTSIDE_BOUNDS',
  SIMULATION_DATA_UNAVAILABLE: 'SIMULATION_DATA_UNAVAILABLE',
} as const;

export type SwapValidationRefusalCode =
  (typeof SWAP_VALIDATION_REFUSAL_CODES)[keyof typeof SWAP_VALIDATION_REFUSAL_CODES];

export class SwapValidationRefusal extends Error {
  readonly code: SwapValidationRefusalCode;
  readonly details?: Record<string, unknown>;

  constructor(code: SwapValidationRefusalCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'SwapValidationRefusal';
    this.code = code;
    this.details = details;
  }
}

export interface ReviewedSwap {
  inputMint: string;
  outputMint: string;
  /** Atomic amount requested from the reviewed order. */
  inputAmountAtomic: string;
  /** Authoritative Jupiter minimum received. */
  minimumOutAmountAtomic: string;
  /** Upper input bound from the reviewed order/safety policy. */
  maximumInputAmountAtomic?: string;
  /** Maximum disclosed lamport network cost used for native SOL bounds. */
  maximumNetworkCostLamports?: string;
  /** Optional stricter account policy supplied by the caller. */
  allowedWritableAccounts?: (string | PublicKey)[];
}

export interface SwapValidationConnection {
  getAddressLookupTable: (
    address: PublicKey,
  ) => Promise<{ value: AddressLookupTableAccount | null } | AddressLookupTableAccount | null>;
  getAccountInfo?: (address: PublicKey) => Promise<unknown>;
  getMultipleAccountsInfo?: (addresses: PublicKey[]) => Promise<(unknown | null)[]>;
}

export interface SwapValidationInput {
  /** Base64 unsigned transaction returned by the server's /swap/order response. */
  serializedTransaction: string;
  activeWallet: string | PublicKey;
  reviewed: ReviewedSwap;
  connection: SwapValidationConnection;
}

export interface ValidatedSwapTransaction {
  ok: true;
  transaction: VersionedTransaction;
  resolvedAddressLookupTableAccounts: AddressLookupTableAccount[];
  activeWallet: string;
  programs: string[];
  accountKeys: string[];
}

export interface RefusedSwapTransaction {
  ok: false;
  code: SwapValidationRefusalCode;
  message: string;
  details?: Record<string, unknown>;
}

export type SwapValidationResult = ValidatedSwapTransaction | RefusedSwapTransaction;

function key(value: string | PublicKey): PublicKey {
  return value instanceof PublicKey ? value : new PublicKey(value);
}

function equalKey(left: PublicKey, right: PublicKey): boolean {
  return left.equals(right);
}

function amount(value: string): bigint | null {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function refusal(error: unknown): RefusedSwapTransaction {
  if (error instanceof SwapValidationRefusal) {
    return { ok: false, code: error.code, message: error.message, details: error.details };
  }
  return {
    ok: false,
    code: SWAP_VALIDATION_REFUSAL_CODES.MALFORMED_TRANSACTION,
    message: 'The swap transaction could not be decoded safely.',
  };
}

function decodeBase64(serialized: string): Buffer {
  if (typeof serialized !== 'string' || serialized.length === 0 || serialized.length % 4 === 1) {
    throw new SwapValidationRefusal(SWAP_VALIDATION_REFUSAL_CODES.MALFORMED_TRANSACTION, 'Serialized transaction is not valid base64.');
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(serialized)) {
    throw new SwapValidationRefusal(SWAP_VALIDATION_REFUSAL_CODES.MALFORMED_TRANSACTION, 'Serialized transaction is not valid base64.');
  }
  const bytes = Buffer.from(serialized, 'base64');
  if (bytes.length === 0) {
    throw new SwapValidationRefusal(SWAP_VALIDATION_REFUSAL_CODES.MALFORMED_TRANSACTION, 'Serialized transaction is empty.');
  }
  return bytes;
}

async function resolveLookupTables(
  transaction: VersionedTransaction,
  connection: SwapValidationConnection,
): Promise<AddressLookupTableAccount[]> {
  const lookups = transaction.message.addressTableLookups as MessageAddressTableLookup[];
  const tables: AddressLookupTableAccount[] = [];
  for (const lookup of lookups) {
    let result: { value: AddressLookupTableAccount | null } | AddressLookupTableAccount | null;
    try {
      result = await connection.getAddressLookupTable(new PublicKey(lookup.accountKey));
    } catch {
      throw new SwapValidationRefusal(
        SWAP_VALIDATION_REFUSAL_CODES.UNRESOLVED_ADDRESS_LOOKUP_TABLE,
        'A transaction address lookup table could not be resolved.',
      );
    }
    const table = result && 'value' in result ? result.value : result;
    if (!table || !table.state || !Array.isArray(table.state.addresses)) {
      throw new SwapValidationRefusal(
        SWAP_VALIDATION_REFUSAL_CODES.UNRESOLVED_ADDRESS_LOOKUP_TABLE,
        'A transaction address lookup table could not be resolved.',
      );
    }
    tables.push(table);
  }
  return tables;
}

function allAccountKeys(transaction: VersionedTransaction, tables: AddressLookupTableAccount[]): PublicKey[] {
  const keys = transaction.message.getAccountKeys({ addressLookupTableAccounts: tables });
  return keys.staticAccountKeys
    .concat(keys.accountKeysFromLookups?.writable ?? [])
    .concat(keys.accountKeysFromLookups?.readonly ?? []);
}

function accountAt(
  transaction: VersionedTransaction,
  tables: AddressLookupTableAccount[],
  index: number,
): PublicKey | undefined {
  const keys = transaction.message.getAccountKeys({ addressLookupTableAccounts: tables });
  if (index < keys.staticAccountKeys.length) return keys.staticAccountKeys[index];
  const loaded = keys.accountKeysFromLookups;
  if (!loaded) return undefined;
  const staticCount = keys.staticAccountKeys.length;
  const writableCount = loaded.writable.length;
  const loadedIndex = index - staticCount;
  return loadedIndex < writableCount ? loaded.writable[loadedIndex] : loaded.readonly[loadedIndex - writableCount];
}

function readU64(data: Uint8Array, offset: number): bigint | null {
  if (data.length < offset + 8) return null;
  let result = 0n;
  for (let index = 0; index < 8; index += 1) result += BigInt(data[offset + index]) << BigInt(index * 8);
  return result;
}

interface TokenAccountEvidence {
  mint: string;
  owner: string;
  amountAtomic?: bigint;
}

function tokenEvidence(value: unknown): TokenAccountEvidence | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const mint = typeof row.mint === 'string' ? row.mint : row.mint instanceof PublicKey ? row.mint.toBase58() : null;
  const owner = typeof row.owner === 'string' ? row.owner : row.owner instanceof PublicKey ? row.owner.toBase58() : null;
  if (mint && owner) {
    const parsed = typeof row.amountAtomic === 'string' && amount(row.amountAtomic) !== null ? amount(row.amountAtomic)! : undefined;
    return { mint, owner, amountAtomic: parsed };
  }
  const raw = row.data instanceof Uint8Array
    ? row.data
    : Buffer.isBuffer(row.data)
      ? row.data
      : Array.isArray(row.data) && typeof row.data[0] === 'string'
        ? Buffer.from(row.data[0], row.data[1] === 'base64' ? 'base64' : 'utf8')
        : null;
  if (!raw || raw.length < 72) return null;
  return {
    mint: new PublicKey(raw.slice(0, 32)).toBase58(),
    owner: new PublicKey(raw.slice(32, 64)).toBase58(),
    amountAtomic: readU64(raw, 64) ?? undefined,
  };
}

function publicKeyField(value: unknown): PublicKey | null {
  if (value instanceof PublicKey) return value;
  if (typeof value === 'string') {
    try { return new PublicKey(value); } catch { return null; }
  }
  return null;
}

function accountProgramOwner(value: unknown): PublicKey | null {
  if (!value || typeof value !== 'object') return null;
  return publicKeyField((value as Record<string, unknown>).owner);
}

function accountIsExecutable(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && (value as Record<string, unknown>).executable === true);
}

async function readAccountInfos(
  connection: SwapValidationConnection,
  addresses: PublicKey[],
): Promise<(unknown | null)[]> {
  if (addresses.length === 0) return [];
  if (connection.getMultipleAccountsInfo) {
    try {
      const values = await connection.getMultipleAccountsInfo(addresses);
      if (values.length === addresses.length) return values;
    } catch {
      // Fall back to individual lookups; an unavailable lookup still fails
      // closed in enforceWritableAccountPolicy below.
    }
  }
  if (!connection.getAccountInfo) return addresses.map(() => null);
  return Promise.all(addresses.map(async (address) => {
    try { return await connection.getAccountInfo!(address); } catch { return null; }
  }));
}

function deterministicAssociatedAccounts(
  transaction: VersionedTransaction,
  tables: AddressLookupTableAccount[],
  wallet: PublicKey,
): Set<string> {
  const result = new Set<string>();
  for (const instruction of transaction.message.compiledInstructions) {
    const program = accountAt(transaction, tables, instruction.programIdIndex);
    if (!program || program.toBase58() !== SWAP_PROGRAM_IDS.associatedToken) continue;
    const ata = accountAt(transaction, tables, instruction.accountKeyIndexes[1]);
    const owner = accountAt(transaction, tables, instruction.accountKeyIndexes[2]);
    const mint = accountAt(transaction, tables, instruction.accountKeyIndexes[3]);
    if (ata && owner?.equals(wallet) && mint) {
      result.add(ata.toBase58());
    }
  }
  return result;
}

async function enforceWritableAccountPolicy(
  transaction: VersionedTransaction,
  tables: AddressLookupTableAccount[],
  wallet: PublicKey,
  reviewed: ReviewedSwap,
  connection: SwapValidationConnection,
): Promise<void> {
  const keys = allAccountKeys(transaction, tables);
  const writable = keys.filter((_, index) => transaction.message.isAccountWritable(index));
  const expected = reviewed.allowedWritableAccounts
    ? new Set([...reviewed.allowedWritableAccounts.map((entry) => key(entry).toBase58()), wallet.toBase58()])
    : null;
  const deterministicAta = deterministicAssociatedAccounts(transaction, tables, wallet);
  const infos = await readAccountInfos(connection, writable);
  const infoByKey = new Map(writable.map((entry, index) => [entry.toBase58(), infos[index] ?? null]));
  const keySet = new Set(keys.map((entry) => entry.toBase58()));

  for (const account of writable) {
    const address = account.toBase58();
    if (account.equals(wallet)) continue;
    if (expected && !expected.has(address)) {
      throw new SwapValidationRefusal(
        SWAP_VALIDATION_REFUSAL_CODES.UNEXPECTED_WRITABLE_ACCOUNT,
        'The transaction writes an account outside the stricter reviewed account set.',
      );
    }
    if (deterministicAta.has(address)) continue;
    const info = infoByKey.get(address);
    if (!info) {
      throw new SwapValidationRefusal(
        SWAP_VALIDATION_REFUSAL_CODES.UNKNOWN_WRITABLE_ACCOUNT,
        'Writable account evidence is unavailable.',
      );
    }
    const programOwner = accountProgramOwner(info);
    const evidence = tokenEvidence(info);
    const isTokenOwned = Boolean(programOwner && TOKEN_PROGRAMS.has(programOwner.toBase58()));
    if (evidence) {
      // Jupiter may route through a wallet-owned intermediary token account
      // (for example SOL -> USDC -> the reviewed output). Static inspection
      // proves ownership; simulation below rejects any net decrease in a mint
      // other than the reviewed input/output pair.
      continue;
    }
    if (isTokenOwned) {
      throw new SwapValidationRefusal(
        SWAP_VALIDATION_REFUSAL_CODES.UNKNOWN_WRITABLE_ACCOUNT,
        'Writable token account evidence is unavailable.',
      );
    }
    if (!programOwner || !keySet.has(programOwner.toBase58())) {
      throw new SwapValidationRefusal(
        SWAP_VALIDATION_REFUSAL_CODES.UNVERIFIED_ROUTE_STATE,
        'Writable route state has no owning program in the resolved transaction.',
      );
    }
    const ownerInfo = infoByKey.get(programOwner.toBase58()) ?? (await readAccountInfos(connection, [programOwner]))[0];
    if (!accountIsExecutable(ownerInfo)) {
      throw new SwapValidationRefusal(
        SWAP_VALIDATION_REFUSAL_CODES.UNVERIFIED_ROUTE_STATE,
        'Writable route state owner is not proven executable.',
      );
    }
  }
}

async function inspectTokenAccounts(
  transaction: VersionedTransaction,
  tables: AddressLookupTableAccount[],
  connection: SwapValidationConnection,
  wallet: PublicKey,
  reviewed: ReviewedSwap,
): Promise<void> {
  const keys = allAccountKeys(transaction, tables);
  const writable = keys.filter((_, index) => transaction.message.isAccountWritable(index));
  const infos = await readAccountInfos(connection, writable);
  let foundReviewedInput = false;
  let foundReviewedInputBalance = false;
  let foundReviewedOutput = false;
  const evidenceByAccount = new Map<string, TokenAccountEvidence>();
  for (const [index, account] of writable.entries()) {
    const info = infos[index];
    const programOwner = accountProgramOwner(info);
    const evidence = tokenEvidence(info);
    const isTokenAccount = Boolean((programOwner && TOKEN_PROGRAMS.has(programOwner.toBase58())) || evidence);
    if (!isTokenAccount) continue;
    if (!evidence) continue;
    evidenceByAccount.set(account.toBase58(), evidence);
    if (evidence.mint === reviewed.inputMint && evidence.owner === wallet.toBase58()) {
      foundReviewedInput = true;
      const minimumInput = amount(reviewed.inputAmountAtomic);
      if (evidence.amountAtomic !== undefined && minimumInput !== null && evidence.amountAtomic >= minimumInput) {
        foundReviewedInputBalance = true;
      }
    }
    if (evidence.mint === reviewed.outputMint) {
      if (evidence.owner === wallet.toBase58()) foundReviewedOutput = true;
    }
  }

  // A newly-created output ATA has no account data yet. Its Create/CreateIdempotent
  // account tuple is deterministic ownership evidence, so accept that specific
  // case without weakening the general fail-closed rule.
  let associatedOutputProof = false;
  for (const instruction of transaction.message.compiledInstructions) {
    const program = accountAt(transaction, tables, instruction.programIdIndex);
    if (!program || program.toBase58() !== SWAP_PROGRAM_IDS.associatedToken) continue;
    const ata = accountAt(transaction, tables, instruction.accountKeyIndexes[1]);
    const owner = accountAt(transaction, tables, instruction.accountKeyIndexes[2]);
    const mint = accountAt(transaction, tables, instruction.accountKeyIndexes[3]);
    if (ata && owner?.equals(wallet) && mint?.toBase58() === reviewed.outputMint) {
      associatedOutputProof = true;
      // If RPC did return this account, it must agree with the deterministic
      // Create instruction rather than silently overriding it.
      const evidence = evidenceByAccount.get(ata.toBase58());
      if (evidence && (evidence.owner !== wallet.toBase58() || evidence.mint !== reviewed.outputMint)) {
        throw new SwapValidationRefusal(
          SWAP_VALIDATION_REFUSAL_CODES.OUTPUT_ACCOUNT_NOT_OWNED,
          'The associated output account does not match the reviewed wallet and mint.',
        );
      }
    }
  }
  if ((!foundReviewedInput || !foundReviewedInputBalance) && reviewed.inputMint !== NATIVE_SOL_MINT) {
    throw new SwapValidationRefusal(
      SWAP_VALIDATION_REFUSAL_CODES.INPUT_MINT_MISMATCH,
      'The reviewed input mint and wallet-owned input account could not be proven.',
    );
  }
  if (!foundReviewedOutput && !associatedOutputProof && reviewed.outputMint !== NATIVE_SOL_MINT) {
    throw new SwapValidationRefusal(
      SWAP_VALIDATION_REFUSAL_CODES.OUTPUT_ACCOUNT_NOT_OWNED,
      'The reviewed output mint and wallet-owned output account could not be proven.',
    );
  }
}

async function inspectInstructions(
  transaction: VersionedTransaction,
  tables: AddressLookupTableAccount[],
  wallet: PublicKey,
  reviewed: ReviewedSwap,
  connection: SwapValidationConnection,
): Promise<void> {
  const keys = allAccountKeys(transaction, tables);
  const staticSignerCount = transaction.message.header.numRequiredSignatures;
  for (let index = 0; index < staticSignerCount; index += 1) {
    const signer = keys[index];
    if (!signer || !equalKey(signer, wallet)) {
      throw new SwapValidationRefusal(
        index === 0 ? SWAP_VALIDATION_REFUSAL_CODES.WRONG_FEE_PAYER : SWAP_VALIDATION_REFUSAL_CODES.UNEXPECTED_REQUIRED_SIGNER,
        index === 0 ? 'The active wallet is not the transaction fee payer.' : 'The transaction requires an unexpected signer.',
      );
    }
  }
  const data = transaction.message.compiledInstructions;
  for (const instruction of data) {
    const program = accountAt(transaction, tables, instruction.programIdIndex);
    if (!program || !ALLOWED_PROGRAMS.has(program.toBase58())) {
      throw new SwapValidationRefusal(
        SWAP_VALIDATION_REFUSAL_CODES.DISALLOWED_PROGRAM,
        'The transaction contains an instruction for a disallowed program.',
        { program: program?.toBase58() },
      );
    }
    if (program.toBase58() === SWAP_PROGRAM_IDS.system) {
      // System transfer is the only static SOL amount available in a v0
      // message. It is useful evidence when the reviewed input is native SOL;
      // Jupiter's opaque route instruction remains intentionally unguessed.
      const systemData = Buffer.from(instruction.data);
      const source = accountAt(transaction, tables, instruction.accountKeyIndexes[0]);
      const lamports = systemData[0] === 2 ? readU64(systemData, 4) : null;
      const reviewedAmount = amount(reviewed.inputAmountAtomic);
      if (source && lamports !== null && reviewedAmount !== null && source.equals(wallet) && reviewed.inputMint === NATIVE_SOL_MINT && lamports !== reviewedAmount) {
        throw new SwapValidationRefusal(
          SWAP_VALIDATION_REFUSAL_CODES.INPUT_AMOUNT_MISMATCH,
          'The wallet SOL transfer amount differs from the reviewed amount.',
        );
      }
      continue;
    }
    if (!TOKEN_PROGRAMS.has(program.toBase58())) continue;
    const instructionData = Buffer.from(instruction.data);
    const opcode = instructionData[0];
    if (opcode === 4 || opcode === 6 || opcode === 13) {
      throw new SwapValidationRefusal(
        SWAP_VALIDATION_REFUSAL_CODES.UNSAFE_TOKEN_INSTRUCTION,
        'Token approval or authority changes are not allowed in a swap.',
      );
    }
    if (opcode === 9) {
      const destination = accountAt(transaction, tables, instruction.accountKeyIndexes[1]);
      if (!destination || !equalKey(destination, wallet)) {
        throw new SwapValidationRefusal(
          SWAP_VALIDATION_REFUSAL_CODES.UNSAFE_CLOSE_ACCOUNT,
          'A token account may only be closed to the active wallet.',
        );
      }
    }
    if (opcode === 3 || opcode === 12) {
      const transferAmount = opcode === 12 ? readU64(instructionData, 1) : readU64(instructionData, 1);
      const reviewedAmount = amount(reviewed.inputAmountAtomic);
      const source = accountAt(transaction, tables, instruction.accountKeyIndexes[0]);
      if (source && transferAmount !== null && reviewedAmount !== null && connection.getAccountInfo) {
        try {
          const evidence = tokenEvidence(await connection.getAccountInfo(source));
          if (evidence?.owner === wallet.toBase58() && evidence.mint === reviewed.inputMint && transferAmount !== reviewedAmount) {
            throw new SwapValidationRefusal(
              SWAP_VALIDATION_REFUSAL_CODES.INPUT_AMOUNT_MISMATCH,
              'The wallet input transfer amount differs from the reviewed amount.',
            );
          }
        } catch (error) {
          if (error instanceof SwapValidationRefusal) throw error;
        }
      }
    }
  }
}

/** Deserialize and inspect a signable Jupiter v6 transaction before wallet prompt. */
async function validateSwapTransactionInternal(input: SwapValidationInput): Promise<SwapValidationResult> {
  try {
    const wallet = key(input.activeWallet);
    const reviewedInput = key(input.reviewed.inputMint).toBase58();
    const reviewedOutput = key(input.reviewed.outputMint).toBase58();
    if (amount(input.reviewed.inputAmountAtomic) === null || amount(input.reviewed.minimumOutAmountAtomic) === null) {
      throw new SwapValidationRefusal(SWAP_VALIDATION_REFUSAL_CODES.MALFORMED_TRANSACTION, 'Reviewed amounts are not canonical atomic integers.');
    }
    const transaction = VersionedTransaction.deserialize(decodeBase64(input.serializedTransaction));
    if (transaction.message.version !== 0) {
      throw new SwapValidationRefusal(SWAP_VALIDATION_REFUSAL_CODES.UNSUPPORTED_TRANSACTION_VERSION, 'Only VersionedTransaction v0 swaps are accepted.');
    }
    const tables = await resolveLookupTables(transaction, input.connection);
    // Normalize reviewed mints before account inspection while retaining the
    // caller's immutable review object for amount comparisons.
    const reviewed = { ...input.reviewed, inputMint: reviewedInput, outputMint: reviewedOutput };
    await inspectInstructions(transaction, tables, wallet, reviewed, input.connection);
    await inspectTokenAccounts(transaction, tables, input.connection, wallet, reviewed);
    await enforceWritableAccountPolicy(transaction, tables, wallet, reviewed, input.connection);
    return {
      ok: true,
      transaction,
      resolvedAddressLookupTableAccounts: tables,
      activeWallet: wallet.toBase58(),
      programs: [...new Set(transaction.message.compiledInstructions.map((item) => accountAt(transaction, tables, item.programIdIndex)?.toBase58()).filter((value): value is string => Boolean(value)))],
      accountKeys: allAccountKeys(transaction, tables).map((entry) => entry.toBase58()),
    };
  } catch (error) {
    return refusal(error);
  }
}

/**
 * Small executor-facing adapter. It throws the typed refusal rather than
 * making every wallet caller repeat the discriminated-union branch.
 */
export async function validateSwapTransactionForSigning(input: {
  transactionBase64: string;
  walletAddress: string | PublicKey;
  inputMint: string;
  outputMint: string;
  inAmountAtomic: string;
  minimumOutAmountAtomic: string;
  /** Optional stricter caller policy; production derives evidence independently. */
  expectedWritableAccounts?: (string | PublicKey)[];
  connection: SwapValidationConnection;
}): Promise<{
  transaction: VersionedTransaction;
  resolvedAddressLookupTableAccounts: AddressLookupTableAccount[];
  warnings?: string[];
}> {
  const result = await validateSwapTransactionInternal({
    serializedTransaction: input.transactionBase64,
    activeWallet: input.walletAddress,
    reviewed: {
      inputMint: input.inputMint,
      outputMint: input.outputMint,
      inputAmountAtomic: input.inAmountAtomic,
      minimumOutAmountAtomic: input.minimumOutAmountAtomic,
      allowedWritableAccounts: input.expectedWritableAccounts,
    },
    connection: input.connection,
  });
  if (!result.ok) throw new SwapValidationRefusal(result.code, result.message, result.details);
  return { transaction: result.transaction, resolvedAddressLookupTableAccounts: result.resolvedAddressLookupTableAccounts };
}

export interface ValidateSwapTransactionForSigningInput {
  transactionBase64: string;
  walletAddress: string | PublicKey;
  inputMint: string;
  outputMint: string;
  inAmountAtomic: string;
  minimumOutAmountAtomic: string;
  expectedWritableAccounts?: (string | PublicKey)[];
  connection: SwapValidationConnection;
}

/**
 * Supports both the detailed discriminated-union form and the flattened
 * executor form. Keeping both avoids coupling wallet code to review DTO names.
 */
export function validateSwapTransaction(input: SwapValidationInput): Promise<SwapValidationResult>;
export function validateSwapTransaction(input: ValidateSwapTransactionForSigningInput): Promise<{
  transaction: VersionedTransaction;
  resolvedAddressLookupTableAccounts: AddressLookupTableAccount[];
  warnings?: string[];
}>;
export async function validateSwapTransaction(
  input: SwapValidationInput | ValidateSwapTransactionForSigningInput,
): Promise<SwapValidationResult | {
  transaction: VersionedTransaction;
  resolvedAddressLookupTableAccounts: AddressLookupTableAccount[];
  warnings?: string[];
}> {
  if ('serializedTransaction' in input) return validateSwapTransactionInternal(input);
  return validateSwapTransactionForSigning(input);
}

export interface SimulatedTokenBalance {
  accountIndex?: number;
  mint: string;
  owner?: string;
  /** Normalized test shape; RPC responses instead use uiTokenAmount.amount. */
  amount?: string | number;
  uiTokenAmount?: { amount: string };
}

export interface SwapSimulationValue {
  err: unknown;
  preBalances?: (number | string | bigint)[];
  postBalances?: (number | string | bigint)[];
  preTokenBalances?: SimulatedTokenBalance[];
  postTokenBalances?: SimulatedTokenBalance[];
}

export interface SwapSimulationResponse {
  value: SwapSimulationValue;
}

export interface SimulatedTokenBalanceChange {
  mint: string;
  beforeAtomic: string;
  afterAtomic: string;
  deltaAtomic: string;
}

export interface SimulatedWalletBalanceChanges {
  nativeLamports: { before: string; after: string; delta: string };
  tokens: SimulatedTokenBalanceChange[];
}

export interface VerifiedSwapSimulation {
  ok: true;
  balanceChanges: SimulatedWalletBalanceChanges;
  outputAmountAtomic: string;
}

export interface RefusedSwapSimulation {
  ok: false;
  code: SwapValidationRefusalCode;
  message: string;
  details?: Record<string, unknown>;
}

export type SwapSimulationResult = VerifiedSwapSimulation | RefusedSwapSimulation;

function integerString(value: number | string | bigint | undefined): string {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value).toString() : '0';
  return value && /^-?[0-9]+$/.test(value) ? value : '0';
}

function tokenAmount(value: string | number): bigint {
  try {
    return BigInt(String(value));
  } catch {
    return 0n;
  }
}

function simulatedAmount(balance: SimulatedTokenBalance): bigint {
  return tokenAmount(balance.uiTokenAmount?.amount ?? balance.amount ?? '0');
}

function delta(before: bigint, after: bigint): string {
  return (after - before).toString();
}

/** Verify an injected RPC simulation and derive exact wallet-owned balance changes. */
export function verifySwapSimulation(
  simulation: SwapSimulationResponse,
  options: { activeWallet: string | PublicKey; reviewed: Pick<ReviewedSwap, 'inputMint' | 'outputMint' | 'inputAmountAtomic' | 'minimumOutAmountAtomic' | 'maximumInputAmountAtomic' | 'maximumNetworkCostLamports'> },
): SwapSimulationResult {
  const wallet = key(options.activeWallet).toBase58();
  const value = simulation?.value;
  if (!value || value.err !== null && value.err !== undefined) {
    return { ok: false, code: SWAP_VALIDATION_REFUSAL_CODES.SIMULATION_FAILED, message: 'Swap simulation failed.' };
  }
  if (!value.preBalances || !value.postBalances || !value.preTokenBalances || !value.postTokenBalances) {
    return { ok: false, code: SWAP_VALIDATION_REFUSAL_CODES.SIMULATION_DATA_UNAVAILABLE, message: 'Simulation did not return token balance changes.' };
  }
  const beforeNative = BigInt(integerString(value.preBalances?.[0]));
  const afterNative = BigInt(integerString(value.postBalances?.[0]));
  const before = new Map<string, bigint>();
  const after = new Map<string, bigint>();
  for (const balance of value.preTokenBalances) {
    if (balance.owner === wallet) before.set(`${balance.accountIndex ?? balance.mint}:${balance.mint}`, simulatedAmount(balance));
  }
  for (const balance of value.postTokenBalances) {
    if (balance.owner === wallet) after.set(`${balance.accountIndex ?? balance.mint}:${balance.mint}`, simulatedAmount(balance));
  }
  const tokenKeys = new Set([...before.keys(), ...after.keys()]);
  const tokens: SimulatedTokenBalanceChange[] = [];
  for (const tokenKey of tokenKeys) {
    const mint = tokenKey.slice(tokenKey.indexOf(':') + 1);
    const beforeAmount = before.get(tokenKey) ?? 0n;
    const afterAmount = after.get(tokenKey) ?? 0n;
    tokens.push({ mint, beforeAtomic: beforeAmount.toString(), afterAtomic: afterAmount.toString(), deltaAtomic: delta(beforeAmount, afterAmount) });
  }
  const outputMint = key(options.reviewed.outputMint).toBase58();
  const inputMint = key(options.reviewed.inputMint).toBase58();
  const reviewedInput = amount(options.reviewed.inputAmountAtomic) ?? 0n;
  const maximumInput = amount(options.reviewed.maximumInputAmountAtomic ?? options.reviewed.inputAmountAtomic) ?? reviewedInput;
  const maximumNetworkCost = amount(options.reviewed.maximumNetworkCostLamports ?? '0') ?? 0n;
  const outputAmount = tokens.filter((entry) => entry.mint === outputMint).reduce((total, entry) => total + BigInt(entry.deltaAtomic), 0n);
  const deltasByMint = new Map<string, bigint>();
  for (const entry of tokens) {
    deltasByMint.set(entry.mint, (deltasByMint.get(entry.mint) ?? 0n) + BigInt(entry.deltaAtomic));
  }
  const unexpectedLosses = [...deltasByMint.entries()]
    .filter(([mint, mintDelta]) => mint !== inputMint && mint !== outputMint && mintDelta < 0n);
  if (unexpectedLosses.length > 0) {
    return {
      ok: false,
      code: SWAP_VALIDATION_REFUSAL_CODES.UNEXPECTED_WALLET_BALANCE_DECREASE,
      message: 'Simulation would reduce an asset outside the reviewed swap pair.',
      details: { losses: unexpectedLosses.map(([mint, mintDelta]) => ({ mint, deltaAtomic: mintDelta.toString() })) },
    };
  }
  const minimum = amount(options.reviewed.minimumOutAmountAtomic) ?? 0n;
  const nativeDelta = afterNative - beforeNative;
  const inputDelta = tokens.filter((entry) => entry.mint === inputMint).reduce((total, entry) => total + BigInt(entry.deltaAtomic), 0n);
  const inputSpent = -inputDelta;
  const nativeInputSpent = -nativeDelta;
  const inputIsNative = inputMint === NATIVE_SOL_MINT;
  const outputIsNative = outputMint === NATIVE_SOL_MINT;
  const inputWithinBounds = inputIsNative
    ? nativeInputSpent >= reviewedInput && nativeInputSpent <= maximumInput + maximumNetworkCost
    : inputSpent >= reviewedInput && inputSpent <= maximumInput;
  if (!inputWithinBounds) {
    return {
      ok: false,
      code: SWAP_VALIDATION_REFUSAL_CODES.SIMULATED_INPUT_OUTSIDE_BOUNDS,
      message: 'Simulation input spend is outside the reviewed bounds.',
      details: { inputSpentAtomic: (inputIsNative ? nativeInputSpent : inputSpent).toString(), inputAmountAtomic: reviewedInput.toString(), maximumInputAmountAtomic: maximumInput.toString(), maximumNetworkCostLamports: maximumNetworkCost.toString() },
    };
  }
  const outputWithinBounds = outputIsNative ? nativeDelta + maximumNetworkCost >= minimum : outputAmount >= minimum;
  if (!outputWithinBounds) {
    return {
      ok: false,
      code: SWAP_VALIDATION_REFUSAL_CODES.SIMULATED_OUTPUT_BELOW_MINIMUM,
      message: 'Simulation output is below the reviewed minimum received.',
      details: { outputAmountAtomic: outputAmount.toString(), minimumOutAmountAtomic: minimum.toString() },
    };
  }
  return {
    ok: true,
    outputAmountAtomic: outputAmount.toString(),
    balanceChanges: {
      nativeLamports: { before: beforeNative.toString(), after: afterNative.toString(), delta: delta(beforeNative, afterNative) },
      tokens,
    },
  };
}

/** Simulate after validation, preserving the injected RPC boundary for tests. */
export async function simulateAndVerifySwap(
  transaction: VersionedTransaction,
  connection: { simulateTransaction: (transaction: VersionedTransaction, config?: { sigVerify?: boolean }) => Promise<SwapSimulationResponse> },
  options: { activeWallet: string | PublicKey; reviewed: Pick<ReviewedSwap, 'inputMint' | 'outputMint' | 'inputAmountAtomic' | 'minimumOutAmountAtomic' | 'maximumInputAmountAtomic' | 'maximumNetworkCostLamports'> },
): Promise<SwapSimulationResult> {
  try {
    // VersionedTransaction simulation defaults sigVerify=false in web3.js;
    // pass it explicitly so an unsigned pre-signature review never requires a
    // wallet signature. This also documents the security boundary for fakes.
    return verifySwapSimulation(await connection.simulateTransaction(transaction, { sigVerify: false }), options);
  } catch {
    return {
      ok: false,
      code: SWAP_VALIDATION_REFUSAL_CODES.SIMULATION_DATA_UNAVAILABLE,
      message: 'Simulation infrastructure is unavailable.',
    };
  }
}

/** Executor-facing simulation adapter with the same typed refusal contract. */
export async function simulateValidatedSwap(input: {
  transaction: VersionedTransaction;
  connection: { simulateTransaction: (transaction: VersionedTransaction, config?: { sigVerify?: boolean }) => Promise<SwapSimulationResponse> };
  walletAddress: string | PublicKey;
  inputMint: string;
  outputMint: string;
  minimumOutAmountAtomic: string;
  inputDecimals?: number;
  outputDecimals?: number;
  /** Required review bounds; pass the exact order amount and disclosed caps. */
  inputAmountAtomic: string;
  maximumInputAmountAtomic: string;
  maximumNetworkCostLamports: string;
}): Promise<{ balanceChanges: SimulatedWalletBalanceChanges; unavailableWarning?: string }> {
  const result = await simulateAndVerifySwap(input.transaction, input.connection, {
    activeWallet: input.walletAddress,
    reviewed: {
      inputMint: input.inputMint,
      outputMint: input.outputMint,
      inputAmountAtomic: input.inputAmountAtomic,
      minimumOutAmountAtomic: input.minimumOutAmountAtomic,
      maximumInputAmountAtomic: input.maximumInputAmountAtomic,
      maximumNetworkCostLamports: input.maximumNetworkCostLamports,
    },
  });
  if (!result.ok) throw new SwapValidationRefusal(result.code, result.message, result.details);
  return { balanceChanges: result.balanceChanges };
}

/**
 * Accept the wallet-returned transaction without relying on object or byte
 * identity. Wallet adapters may reconstruct a VersionedTransaction while
 * signing. An unchanged reviewed message needs only a valid wallet signature;
 * a changed message must pass the full account/program policy again and must
 * reproduce the reviewed spend/output bounds in a fresh simulation.
 */
export async function finalizeWalletSignedSwapTransaction(input: {
  reviewedTransactionBase64: string;
  signedTransaction: VersionedTransaction;
  walletAddress: string | PublicKey;
  inputMint: string;
  outputMint: string;
  inputAmountAtomic: string;
  maximumInputAmountAtomic: string;
  maximumNetworkCostLamports: string;
  minimumOutAmountAtomic: string;
  connection: SwapValidationConnection & {
    simulateTransaction: (
      transaction: VersionedTransaction,
      config?: { sigVerify?: boolean },
    ) => Promise<SwapSimulationResponse>;
  };
}): Promise<VersionedTransaction> {
  const reviewedTransaction = VersionedTransaction.deserialize(decodeBase64(input.reviewedTransactionBase64));
  const reviewedMessage = Buffer.from(reviewedTransaction.message.serialize());
  const signedMessage = Buffer.from(input.signedTransaction.message.serialize());
  const signature = input.signedTransaction.signatures[0];
  const wallet = key(input.walletAddress);

  if (!signature || signature.length !== 64 || signature.every((byte) => byte === 0)) {
    throw new SwapValidationRefusal(
      SWAP_VALIDATION_REFUSAL_CODES.MALFORMED_TRANSACTION,
      'The wallet did not return a valid transaction signature.',
    );
  }
  if (!nacl.sign.detached.verify(signedMessage, signature, wallet.toBytes())) {
    throw new SwapValidationRefusal(
      SWAP_VALIDATION_REFUSAL_CODES.MALFORMED_TRANSACTION,
      'The wallet returned an invalid transaction signature.',
    );
  }

  if (signedMessage.equals(reviewedMessage)) return input.signedTransaction;

  // Some adapters return a reconstructed message even though the signature is
  // for the exact reviewed bytes. Preserve the reviewed transaction in that
  // case and attach only the verified signature.
  if (nacl.sign.detached.verify(reviewedMessage, signature, wallet.toBytes())) {
    reviewedTransaction.signatures[0] = Uint8Array.from(signature);
    return reviewedTransaction;
  }

  const revalidated = await validateSwapTransactionForSigning({
    transactionBase64: Buffer.from(input.signedTransaction.serialize()).toString('base64'),
    walletAddress: wallet,
    inputMint: input.inputMint,
    outputMint: input.outputMint,
    inAmountAtomic: input.inputAmountAtomic,
    minimumOutAmountAtomic: input.minimumOutAmountAtomic,
    connection: input.connection,
  });
  const simulation = await simulateAndVerifySwap(revalidated.transaction, input.connection, {
    activeWallet: wallet,
    reviewed: {
      inputMint: input.inputMint,
      outputMint: input.outputMint,
      inputAmountAtomic: input.inputAmountAtomic,
      maximumInputAmountAtomic: input.maximumInputAmountAtomic,
      maximumNetworkCostLamports: input.maximumNetworkCostLamports,
      minimumOutAmountAtomic: input.minimumOutAmountAtomic,
    },
  });
  if (!simulation.ok) {
    throw new SwapValidationRefusal(
      simulation.code,
      simulation.code === SWAP_VALIDATION_REFUSAL_CODES.SIMULATION_DATA_UNAVAILABLE
        ? 'The signed swap could not be verified. Please try again.'
        : simulation.message,
      simulation.details,
    );
  }
  return revalidated.transaction;
}
