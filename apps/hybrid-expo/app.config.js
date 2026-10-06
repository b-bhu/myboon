// Dynamic Expo config.
//
// The static app.json remains the source of truth for every field. Expo reads it
// first and passes the parsed result in as `config`; this file runs the release
// and client-credential fences before returning that config untouched.
//
// Fence: `EXPO_PUBLIC_PREDICT_E2E=1` swaps the wallet layer for a stub that hands
// every caller the same fixed keypair and a constant 64-byte signature
// (hooks/useWallet.native.ts, hooks/useWallet.web.ts, hooks/usePolymarketWallet.ts).
// EXPO_PUBLIC_ variables are inlined into the bundle at build time, so a release
// built with that flag set would put every user on one publicly computable wallet.
// This file is evaluated on every config read — dev server start, prebuild, EAS
// build and `expo export` alike — so throwing here fails the build before any
// artifact is produced, rather than at runtime after the key already shipped.

const E2E_FLAG = 'EXPO_PUBLIC_PREDICT_E2E';

/**
 * Only the exact string `1` arms the stub. `useWallet.native.ts` and its siblings
 * gate on `=== '1'`, so `0`, the empty string and unset must all stay buildable —
 * matching the flag loosely here would break ordinary releases.
 */
function e2eStubEnabled(env) {
  return env[E2E_FLAG] === '1';
}

/**
 * True when this evaluation belongs to a build whose artifact could reach a user.
 *
 * No single environment variable covers every release path this project uses, so
 * each shipping route contributes its own signal and any one of them is enough:
 *
 * - `EAS_BUILD_PROFILE === 'production'` — set by EAS Build inside the build
 *   container. This is the Play Store AAB route (`pnpm android:aab`).
 * - `EAS_BUILD` with a non-internal distribution — covers the `preview` and
 *   `dapp-store` profiles in eas.json, which produce installable APKs. They are
 *   not the `production` profile but they are still artifacts handed to people,
 *   so a shared signing key in them is the same disclosure.
 * - `NODE_ENV === 'production'` — what `expo export` sets for the static web
 *   output configured in app.json (`web.output: "static"`), and the signal for a
 *   local `expo run:android --variant release`.
 *
 * Erring toward treating a build as production is deliberate: a false positive
 * costs a developer one unset variable, while a false negative ships the key.
 */
function isProductionBuild(env) {
  if (env.EAS_BUILD_PROFILE === 'production') return true;
  if (env.EAS_BUILD === 'true' && env.EAS_BUILD_PROFILE !== 'development') return true;
  if (env.NODE_ENV === 'production') return true;
  return false;
}

function assertE2EStubIsFencedOff(env) {
  if (!e2eStubEnabled(env)) return;
  if (!isProductionBuild(env)) return;

  const profile = env.EAS_BUILD_PROFILE ?? '(none)';
  throw new Error(
    [
      `${E2E_FLAG}=1 is set in a production build. Refusing to build.`,
      '',
      `${E2E_FLAG}=1 replaces the wallet with an E2E stub that gives every user the`,
      'same hardcoded address and a constant 64-byte signature. EXPO_PUBLIC_ values are',
      'inlined into the bundle, so this artifact would ship one publicly computable',
      'wallet shared by everyone who installs it.',
      '',
      `Detected: ${E2E_FLAG}=1, EAS_BUILD_PROFILE=${profile}, NODE_ENV=${env.NODE_ENV ?? '(none)'}`,
      '',
      `Fix: unset ${E2E_FLAG} for this build. It belongs only to the Predict E2E`,
      'harness (playwright.predict.config.ts), which sets it on its own dev server.',
    ].join('\n'),
  );
}

/**
 * Every `EXPO_PUBLIC_` variable the app cannot function without.
 *
 * `.env` is gitignored and EAS builds from git, so an EAS build sees *only*
 * what `eas.json`'s `env` block provides — never the local `.env`. That
 * asymmetry is invisible during development: `expo run:android` reads `.env`
 * off disk and works, while the EAS artifact ships with the variable undefined
 * and fails at runtime, far from the cause. It cost us a debugging cycle when
 * the Privy keys were missing from every EAS profile and login silently died.
 *
 * Listing them here turns that into a build-time failure naming the variable.
 */
const REQUIRED_PUBLIC_ENV = [
  ['EXPO_PUBLIC_API_BASE_URL', 'the API every screen reads from'],
  ['EXPO_PUBLIC_PRIVY_APP_ID', 'Privy auth — login and embedded wallets'],
  ['EXPO_PUBLIC_PRIVY_CLIENT_ID', 'Privy auth — required for mobile clients'],
];

// RPC credentials belong to the API, including keys embedded in URL paths or
// queries. The app derives its RPC endpoints from EXPO_PUBLIC_API_BASE_URL.
const RETIRED_RPC_ENV = new Set([
  'EXPO_PUBLIC_SOLANA_RPC_URL',
  'EXPO_PUBLIC_POLYGON_RPC_URL',
]);

function credentialName(name) {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  return /(?:apikey|apisecret|privatekey|secret|password|accesstoken)$/.test(normalized)
    || /(?:jup(?:iter)?|helius|alchemy|quicknode|quiknode)(?:rpc)?(?:key|token|apitoken)$/.test(normalized);
}

function credentialUrl(value) {
  if (typeof value !== 'string' || !/^(?:https?|wss?):\/\//i.test(value)) return false;
  try {
    const url = new URL(value);
    if (url.username || url.password) return true;
    for (const name of url.searchParams.keys()) {
      if (credentialName(name) || ['key', 'token', 'auth'].includes(name.toLowerCase())) return true;
    }
    // These providers encode credentials in paths, so query-only checks miss
    // an Alchemy URL such as /v2/<key>. No provider RPC URL belongs in the app.
    return /(?:^|\.)(?:helius-rpc\.com|helius\.xyz|alchemy\.com|alchemyapi\.io|quiknode\.pro)$/.test(url.hostname);
  } catch {
    return false;
  }
}

function assertClientCredentialsAreAbsent(env, config) {
  const forbidden = [];
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith('EXPO_PUBLIC_') || !value?.trim()) continue;
    if (RETIRED_RPC_ENV.has(name) || credentialName(name) || credentialUrl(value)) forbidden.push(name);
  }
  const seen = new Set();
  function inspect(value, path) {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    for (const [name, item] of Object.entries(value)) {
      const itemPath = `${path}.${name}`;
      if (item && (credentialName(name) || credentialUrl(item))) forbidden.push(itemPath);
      else inspect(item, itemPath);
    }
  }
  inspect(config.extra, 'extra');
  if (forbidden.length === 0) return;
  throw new Error(
    `Client credentials are forbidden: ${forbidden.join(', ')}. `
    + 'Keep Jupiter and RPC credentials in the API environment; the app uses the backend gateway. '
    + 'Remove retired public RPC overrides. Credential values are intentionally omitted.',
  );
}

/**
 * Enforced only for builds that can reach a user, matching the E2E fence above.
 * A developer running `expo start` against a half-filled `.env` is a normal
 * working state and must not be blocked.
 */
function assertRequiredEnvIsPresent(env) {
  if (!isProductionBuild(env)) return;

  const missing = REQUIRED_PUBLIC_ENV.filter(([name]) => !env[name]?.trim());
  if (missing.length === 0) return;

  throw new Error(
    [
      `Missing required environment ${missing.length === 1 ? 'variable' : 'variables'} in a production build. Refusing to build.`,
      '',
      ...missing.map(([name, why]) => `  ${name} — ${why}`),
      '',
      'EXPO_PUBLIC_ values are inlined at build time, so this artifact would ship',
      'with them undefined and fail at runtime instead of here.',
      '',
      `Detected: EAS_BUILD_PROFILE=${env.EAS_BUILD_PROFILE ?? '(none)'}, NODE_ENV=${env.NODE_ENV ?? '(none)'}`,
      '',
      'Fix: add them to this profile\'s `env` block in eas.json, or set them as EAS',
      'environment variables (`eas env:create`). A local .env does not reach EAS —',
      'it is gitignored, and EAS builds from git.',
    ].join('\n'),
  );
}

module.exports = ({ config }) => {
  assertClientCredentialsAreAbsent(process.env, config);
  assertE2EStubIsFencedOff(process.env);
  assertRequiredEnvIsPresent(process.env);
  return config;
};
