const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { runInNewContext } = require('node:vm');

const source = readFileSync(join(__dirname, '../app.config.js'), 'utf8');
const publicEnv = {
  EXPO_PUBLIC_API_BASE_URL: 'https://api.example.test',
  EXPO_PUBLIC_PRIVY_APP_ID: 'public-app-id',
  EXPO_PUBLIC_PRIVY_CLIENT_ID: 'public-client-id',
};

function evaluate(env, config = { extra: { eas: { projectId: 'public-project' } } }) {
  const module = { exports: {} };
  runInNewContext(source, { module, process: { env }, URL });
  return module.exports({ config });
}

test('development and release config need no client RPC credentials', () => {
  for (const flags of [{}, { NODE_ENV: 'production' }, { EAS_BUILD: 'true', EAS_BUILD_PROFILE: 'preview' }]) {
    const config = { extra: { eas: { projectId: 'public-project' } } };
    assert.equal(evaluate({ ...publicEnv, ...flags, JUP_API_KEY: 'backend-only-secret' }, config), config);
  }
});

test('public Jupiter/provider secrets and retired RPC overrides fail without printing values', () => {
  for (const name of [
    'EXPO_PUBLIC_JUP_API_KEY', 'EXPO_PUBLIC_JUPITER_API_KEY', 'EXPO_PUBLIC_JUPITER_KEY',
    'EXPO_PUBLIC_JUP_API_TOKEN', 'EXPO_PUBLIC_HELIUS_API_KEY', 'EXPO_PUBLIC_ALCHEMY_API_KEY',
    'EXPO_PUBLIC_HELIUS_KEY', 'EXPO_PUBLIC_HELIUS_RPC_KEY', 'EXPO_PUBLIC_HELIUS_TOKEN',
    'EXPO_PUBLIC_ALCHEMY_KEY', 'EXPO_PUBLIC_ALCHEMY_TOKEN', 'EXPO_PUBLIC_QUICKNODE_KEY',
    'EXPO_PUBLIC_PRIVATE_KEY', 'EXPO_PUBLIC_SOLANA_RPC_URL', 'EXPO_PUBLIC_POLYGON_RPC_URL',
  ]) {
    assert.throws(() => evaluate({ ...publicEnv, [name]: 'fixture-sensitive-value' }), (error) => {
      assert.ok(error.message.includes(name));
      assert.equal(error.message.includes('fixture-sensitive-value'), false);
      return true;
    });
  }
});

test('URL-embedded credentials cannot hide in another public variable or manifest extra', () => {
  for (const value of [
    'https://example.test/?api-key=fixture-sensitive-value',
    'https://example.test/?api_key=fixture-sensitive-value',
    'https://example.test/?token=fixture-sensitive-value',
    'https://user:fixture-sensitive-value@example.test',
    'https://polygon-mainnet.g.alchemy.com/v2/fixture-sensitive-value',
    'wss://beta.helius-rpc.com/?api-key=fixture-sensitive-value',
  ]) {
    for (const config of [undefined, { extra: { nested: { endpoint: value } } }]) {
      assert.throws(() => evaluate(
        { ...publicEnv, ...(config ? {} : { EXPO_PUBLIC_CUSTOM_URL: value }) }, config,
      ), (error) => {
        assert.equal(error.message.includes('fixture-sensitive-value'), false);
        return true;
      });
    }
  }
  assert.throws(() => evaluate(publicEnv, { extra: { nested: { jupiterApiKey: 'fixture-sensitive-value' } } }), /extra.nested.jupiterApiKey/);
});

test('public authentication IDs remain usable and existing release fences stay active', () => {
  assert.doesNotThrow(() => evaluate({ ...publicEnv, EXPO_PUBLIC_TURNKEY_AUTH_PROXY_CONFIG_ID: 'public-id' }));
  assert.throws(() => evaluate({ ...publicEnv, NODE_ENV: 'production', EXPO_PUBLIC_PREDICT_E2E: '1' }), /E2E stub/);
  assert.throws(() => evaluate({ ...publicEnv, NODE_ENV: 'production', EXPO_PUBLIC_PRIVY_CLIENT_ID: '' }), /EXPO_PUBLIC_PRIVY_CLIENT_ID/);
});
