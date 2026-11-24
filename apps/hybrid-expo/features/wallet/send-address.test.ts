import assert from 'node:assert/strict';
import test from 'node:test';
import { SEND_ADDRESS_ERROR, SOLANA_ADDRESS_PATTERN, sendAddressError } from './send-address';

// Issue #823: a Solana address is 32 bytes in base58 — 32..44 characters from
// the base58 alphabet (no 0, O, I, l), the exact rule SOLANA_ADDRESS_PATTERN
// in packages/api/src/wallet-move/routes.ts applies.

test('send address: valid set shows no error', () => {
  assert.equal(SEND_ADDRESS_ERROR, 'This is not a Solana address.');
  assert.equal(SOLANA_ADDRESS_PATTERN.test('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'), true); // 44 · USDC mint
  assert.equal(SOLANA_ADDRESS_PATTERN.test('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'), true); // 44 · mock's receive address
  assert.equal(SOLANA_ADDRESS_PATTERN.test('So11111111111111111111111111111111111111112'), true); // 43 · wrapped SOL mint
  assert.equal(SOLANA_ADDRESS_PATTERN.test('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), true); // 44 · SPL Token program
  assert.equal(SOLANA_ADDRESS_PATTERN.test('11111111111111111111111111111111'), true); // 32 · shortest allowed

  for (const address of [
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
    'So11111111111111111111111111111111111111112',
    'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  ]) {
    assert.equal(sendAddressError(address), null);
  }
});

test('send address: invalid set shows the plain error', () => {
  const address = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
  const bad = (ch: string) => ch + address.slice(1); // keep the length, break the alphabet
  // 0, O, I and l are not in the base58 alphabet.
  assert.equal(SOLANA_ADDRESS_PATTERN.test(bad('0')), false);
  assert.equal(SOLANA_ADDRESS_PATTERN.test(bad('O')), false);
  assert.equal(SOLANA_ADDRESS_PATTERN.test(bad('I')), false);
  assert.equal(SOLANA_ADDRESS_PATTERN.test(bad('l')), false);
  // 31 and 45 base58 characters are outside the 32..44 range; 0x… EVM text too.
  assert.equal(SOLANA_ADDRESS_PATTERN.test('1'.repeat(31)), false);
  assert.equal(SOLANA_ADDRESS_PATTERN.test('1'.repeat(45)), false);
  assert.equal(SOLANA_ADDRESS_PATTERN.test('BC1QW508d6PqJhS9x8Z9vJ9uPzCkE9mV9X7Yz'), false);

  assert.equal(sendAddressError(bad('0')), SEND_ADDRESS_ERROR);
  assert.equal(sendAddressError(bad('O')), SEND_ADDRESS_ERROR);
  assert.equal(sendAddressError('1'.repeat(31)), SEND_ADDRESS_ERROR);
  assert.equal(sendAddressError('1'.repeat(45)), SEND_ADDRESS_ERROR);
  assert.equal(sendAddressError(address + ' '), SEND_ADDRESS_ERROR); // a space is not base58
  // Fixing the address clears the error: same string the invalid check rejects.
  assert.equal(sendAddressError(bad('0').slice(1)), null);
});

test('send address: an empty field shows no error', () => {
  assert.equal(sendAddressError(''), null);
});
