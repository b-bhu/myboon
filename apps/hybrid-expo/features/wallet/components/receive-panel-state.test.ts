import assert from 'node:assert/strict';
import test from 'node:test';
import { receivePanelState } from './receive-panel-state';

// Issue #719: one pure test for the panel-state helper — both connected,
// only Solana, only EVM, neither, dormant EVM.
test('receive panel state: connected, dormant-evm and not-connected per toggle', () => {
  // Both connected → the QR card for each toggle.
  assert.equal(
    receivePanelState({ chain: 'solana', solanaAddress: 'Sol1', evmAddress: '0x1', activeChains: ['solana', 'evm'] }),
    'connected',
  );
  assert.equal(
    receivePanelState({ chain: 'evm', solanaAddress: 'Sol1', evmAddress: '0x1', activeChains: ['solana', 'evm'] }),
    'connected',
  );

  // Only Solana → Solana QR card; EVM was never activated → connect prompt.
  assert.equal(
    receivePanelState({ chain: 'solana', solanaAddress: 'Sol1', evmAddress: null, activeChains: ['solana'] }),
    'connected',
  );
  assert.equal(
    receivePanelState({ chain: 'evm', solanaAddress: 'Sol1', evmAddress: null, activeChains: ['solana'] }),
    'not-connected',
  );

  // Only EVM → EVM QR card; Solana not connected → connect prompt.
  assert.equal(
    receivePanelState({ chain: 'evm', solanaAddress: null, evmAddress: '0x1', activeChains: ['evm'] }),
    'connected',
  );
  assert.equal(
    receivePanelState({ chain: 'solana', solanaAddress: null, evmAddress: '0x1', activeChains: ['evm'] }),
    'not-connected',
  );

  // Neither address and neither chain active → connect prompt for both.
  assert.equal(
    receivePanelState({ chain: 'solana', solanaAddress: null, evmAddress: null, activeChains: [] }),
    'not-connected',
  );
  assert.equal(
    receivePanelState({ chain: 'evm', solanaAddress: null, evmAddress: null, activeChains: [] }),
    'not-connected',
  );

  // Active EVM without an embedded wallet is "not set up yet", not connect.
  assert.equal(
    receivePanelState({ chain: 'evm', solanaAddress: 'Sol1', evmAddress: null, activeChains: ['solana', 'evm'] }),
    'dormant-evm',
  );
});
