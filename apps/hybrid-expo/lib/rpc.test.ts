import assert from 'node:assert/strict';
import test from 'node:test';
import { resolvePolygonRpcUrl, resolveSolanaRpcUrl, resolveSolanaRpcWsUrl } from './rpc';

function withApiBase(base: string | undefined, run: () => void) {
  const previous = process.env.EXPO_PUBLIC_API_BASE_URL;
  if (base === undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL;
  else process.env.EXPO_PUBLIC_API_BASE_URL = base;
  try {
    run();
  } finally {
    if (previous === undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL;
    else process.env.EXPO_PUBLIC_API_BASE_URL = previous;
  }
}

test('RPC helpers keep provider credentials out of client endpoints', () => {
  const solanaProviderUrl = process.env.EXPO_PUBLIC_SOLANA_RPC_URL;
  const polygonProviderUrl = process.env.EXPO_PUBLIC_POLYGON_RPC_URL;
  process.env.EXPO_PUBLIC_SOLANA_RPC_URL = 'https://helius.example/?api-key=secret';
  process.env.EXPO_PUBLIC_POLYGON_RPC_URL = 'https://alchemy.example/v2/secret';
  try {
    withApiBase('https://api.myboon.test/', () => {
      assert.equal(resolveSolanaRpcUrl(), 'https://api.myboon.test/rpc/solana');
      assert.equal(resolveSolanaRpcUrl('devnet'), 'https://api.myboon.test/rpc/solana-devnet');
      assert.equal(resolvePolygonRpcUrl(), 'https://api.myboon.test/rpc/polygon');
    });
  } finally {
    if (solanaProviderUrl === undefined) delete process.env.EXPO_PUBLIC_SOLANA_RPC_URL;
    else process.env.EXPO_PUBLIC_SOLANA_RPC_URL = solanaProviderUrl;
    if (polygonProviderUrl === undefined) delete process.env.EXPO_PUBLIC_POLYGON_RPC_URL;
    else process.env.EXPO_PUBLIC_POLYGON_RPC_URL = polygonProviderUrl;
  }
});

test('Solana WebSocket helpers retain the API port and select the matching scheme', () => {
  withApiBase('http://localhost:3000', () => {
    assert.equal(resolveSolanaRpcWsUrl(), 'ws://localhost:3000/rpc/solana');
    assert.equal(resolveSolanaRpcWsUrl('devnet'), 'ws://localhost:3000/rpc/solana-devnet');
  });
  withApiBase('https://api.myboon.test:8443', () => {
    assert.equal(resolveSolanaRpcWsUrl(), 'wss://api.myboon.test:8443/rpc/solana');
  });
});

test('RPC helpers resolve the current API base for each request', () => {
  withApiBase('https://first.myboon.test', () => {
    assert.equal(resolveSolanaRpcUrl(), 'https://first.myboon.test/rpc/solana');
  });
  withApiBase('http://localhost:3000', () => {
    assert.equal(resolveSolanaRpcUrl(), 'http://localhost:3000/rpc/solana');
  });
});
