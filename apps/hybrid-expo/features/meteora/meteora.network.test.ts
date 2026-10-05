import assert from 'node:assert/strict';
import test from 'node:test';
import { assertMeteoraWalletNetwork } from './meteora.network';

test('mainnet wallets can use Meteora execution', () => {
  assert.doesNotThrow(() => assertMeteoraWalletNetwork('mainnet-beta'));
});

test('devnet wallets are blocked before mainnet Meteora execution or recovery', () => {
  assert.throws(() => assertMeteoraWalletNetwork('devnet'), /Meteora requires a Solana mainnet wallet/);
});
