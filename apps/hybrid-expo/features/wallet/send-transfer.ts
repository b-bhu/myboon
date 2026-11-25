/**
 * Solana USDC transfer: build, sign, send, confirm — issue #824.
 *
 * Phone-side only: no MyBoon server call. The `Connection` and the sign-only
 * `signTransaction` are passed in by the caller (this file imports no Privy
 * code; nothing is signed without a confirmed swipe — the caller, #825, owns
 * that gate).
 *
 * A recipient with no USDC token account gets it created by the same
 * transaction and the sender pays the rent (owner decision, Nov 24/25).
 * `planSendUsdc` reports that cost so #825 can show it before the slider.
 *
 * The module keeps the last failed-at-`confirm` signature for each
 * (sender, recipient, amount). A repeat call with the same inputs first
 * checks that signature on chain: confirmed → return it and send nothing;
 * not found → build and send again (owner decision, Nov 25). Every other
 * failure or a repeat after any other step's failure just runs the transfer
 * again from the start — the function is safe to call again.
 *
 * Amounts are atomic strings at SEND_USDC_DECIMALS (6). Developer-facing
 * messages only; user copy is #825's.
 */

import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { PublicKey, Transaction, type Connection } from '@solana/web3.js';
import { SEND_USDC_DECIMALS, SEND_USDC_MINT } from './send-panel.state';

const USDC_MINT = new PublicKey(SEND_USDC_MINT);

/** SPL token accounts (TOKEN_PROGRAM_ID) are 165 bytes of data. */
export const SPL_TOKEN_ACCOUNT_SIZE = 165;

/** Sign-only: the caller's wallet signs the built transaction, never sends. */
export type SendUsdcSignTransaction = (transaction: Transaction) => Promise<Transaction>;

export type SendResultStep = 'build' | 'sign' | 'send' | 'confirm';

export type SendResult =
  | { status: 'confirmed'; signature: string }
  | { status: 'cancelled' }
  | { status: 'failed'; step: SendResultStep; message: string; signature?: string };

export interface UsdcTransferInput {
  fromAddress: string;
  toAddress: string;
  amountAtomic: string;
  balanceAtomic: string;
  connection: Connection;
}

export interface SendUsdcPlan {
  needsRecipientAccount: boolean;
  rentLamports: number;
}

/** The sender's or recipient's USDC associated token account. */
export function usdcAssociatedTokenAddress(ownerAddress: string): PublicKey {
  return getAssociatedTokenAddressSync(
    USDC_MINT,
    new PublicKey(ownerAddress),
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
}

/** Atomic amounts are digit strings; anything else is a caller bug. */
function parseAtomic(label: string, atomic: string): bigint {
  if (!/^\d+$/.test(atomic)) {
    throw new Error(`${label} is not an atomic unsigned-integer string: ${JSON.stringify(atomic)}`);
  }
  return BigInt(atomic);
}

function failAt(step: SendResultStep, error: unknown, signature?: string): SendResult {
  const message = error instanceof Error ? error.message : String(error);
  return signature === undefined
    ? { status: 'failed', step, message }
    : { status: 'failed', step, message, signature };
}

/**
 * Pre-slider planning for #825: does the recipient need a USDC token account
 * created, and what would its rent cost? Amounts are parsed to reject a
 * malformed shape early; the over-balance rule is the send's, not the plan's.
 */
export async function planSendUsdc({
  toAddress,
  amountAtomic,
  balanceAtomic,
  connection,
}: UsdcTransferInput): Promise<SendUsdcPlan> {
  parseAtomic('amountAtomic', amountAtomic);
  parseAtomic('balanceAtomic', balanceAtomic);

  const recipientTokenAccount = usdcAssociatedTokenAddress(toAddress);
  if ((await connection.getAccountInfo(recipientTokenAccount)) !== null) {
    return { needsRecipientAccount: false, rentLamports: 0 };
  }
  const rentLamports = await connection.getMinimumBalanceForRentExemption(SPL_TOKEN_ACCOUNT_SIZE);
  return { needsRecipientAccount: true, rentLamports };
}

/** Last failed-at-confirm signature per `sender|recipient|amount`. */
const confirmTimeoutSignatures = new Map<string, string>();

async function signatureConfirmed(connection: Connection, signature: string): Promise<boolean> {
  const [status] = (await connection.getSignatureStatuses([signature])).value;
  // A processed (or better) transaction without an error is on its way to
  // being finalized; sending a duplicate here would double-spend.
  return !!status && status.err === null && status.confirmationStatus !== null;
}

/**
 * Build, sign, send once and confirm one USDC transfer. Each failure step is
 * reported in the result; only a failure at `confirm` leaves a signature the
 * next same-input call must check before it sends again.
 */
export async function sendUsdcOnSolana({
  fromAddress,
  toAddress,
  amountAtomic,
  balanceAtomic,
  connection,
  signTransaction,
}: UsdcTransferInput & { signTransaction: SendUsdcSignTransaction }): Promise<SendResult> {
  const retryKey = `${fromAddress}|${toAddress}|${amountAtomic}`;

  // Build, part 1: parse and the over-balance rule happen before any signer
  // or network use.
  let amount: bigint;
  try {
    amount = parseAtomic('amountAtomic', amountAtomic);
    const balance = parseAtomic('balanceAtomic', balanceAtomic);
    if (amount > balance) {
      throw new Error(`Send amount ${amountAtomic} exceeds the USDC balance ${balanceAtomic}.`);
    }
  } catch (error) {
    return failAt('build', error);
  }

  if (confirmTimeoutSignatures.has(retryKey)) {
    const savedSignature = confirmTimeoutSignatures.get(retryKey) as string;
    confirmTimeoutSignatures.delete(retryKey);
    try {
      if (await signatureConfirmed(connection, savedSignature)) {
        return { status: 'confirmed', signature: savedSignature };
      }
    } catch (error) {
      // The chain lookup failed: the earlier send's outcome is unknown, so
      // refuse to send a possible duplicate.
      return failAt('confirm', error, savedSignature);
    }
  }

  // Build, part 2: token accounts, instructions and a recent blockhash.
  let unsigned: Transaction;
  let blockhash: string;
  let lastValidBlockHeight: number;
  try {
    const { needsRecipientAccount } = await planSendUsdc({
      fromAddress,
      toAddress,
      amountAtomic,
      balanceAtomic,
      connection,
    });
    const sender = new PublicKey(fromAddress);
    const recipient = new PublicKey(toAddress);
    unsigned = new Transaction({ feePayer: sender });
    // Rent for the new account moves with the same transaction; the sender
    // is its fee payer, i.e. the rent payer.
    if (needsRecipientAccount) {
      unsigned.add(
        createAssociatedTokenAccountInstruction(
          sender,
          usdcAssociatedTokenAddress(toAddress),
          recipient,
          USDC_MINT,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID,
        ),
      );
    }
    unsigned.add(
      createTransferCheckedInstruction(
        usdcAssociatedTokenAddress(fromAddress),
        USDC_MINT,
        usdcAssociatedTokenAddress(toAddress),
        sender,
        amount,
        SEND_USDC_DECIMALS,
        undefined,
        TOKEN_PROGRAM_ID,
      ),
    );
    ({ blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash());
    unsigned.recentBlockhash = blockhash;
  } catch (error) {
    return failAt('build', error);
  }

  let signed: Transaction;
  try {
    signed = await signTransaction(unsigned);
  } catch {
    // A rejection, a cancel or any signer failure: nothing is sent.
    return { status: 'cancelled' };
  }

  let wire: Uint8Array;
  try {
    wire = signed.serialize();
  } catch (error) {
    return failAt('sign', error);
  }

  let signature: string;
  try {
    // Exactly one send attempt per call; a retried send is a new call.
    signature = await connection.sendRawTransaction(wire);
  } catch (error) {
    return failAt('send', error);
  }

  try {
    const confirmed = await connection.confirmTransaction(
      { blockhash, lastValidBlockHeight, signature },
      'confirmed',
    );
    if (confirmed.value.err) {
      confirmTimeoutSignatures.set(retryKey, signature);
      return failAt(
        'confirm',
        new Error(`Solana rejected the transfer: ${JSON.stringify(confirmed.value.err)}`),
        signature,
      );
    }
  } catch (error) {
    // Confirmation did not arrive: the send may still land, so the next
    // same-input call must check this signature on chain first.
    confirmTimeoutSignatures.set(retryKey, signature);
    return failAt('confirm', error, signature);
  }

  return { status: 'confirmed', signature };
}
