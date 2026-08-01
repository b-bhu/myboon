// URL/URLSearchParams polyfill — must be first. Without it, different bundle
// chunks can resolve `URLSearchParams` to different constructor references
// under Metro/Hermes, so `instanceof URLSearchParams` checks fail silently
// across module boundaries. This broke @polymarket/client's SDK (which
// builds query params as a URLSearchParams instance) talking to `ky` (which
// gates its own query-string serialization on `instanceof URLSearchParams`):
// the check failed, ky treated a real, non-empty URLSearchParams as "no
// params", and every request lost its query string — reproducible only on
// device, never in a Node script, because Node has one single global
// URLSearchParams with no bundler-caused realm split.
import 'react-native-url-polyfill/auto';

// Privy required polyfills (must be imported before anything else)
import 'fast-text-encoding';
import 'react-native-get-random-values';
import '@ethersproject/shims';

// Existing polyfill (react-native-quick-crypto)
import './polyfill';

// JSON.stringify has never natively supported bigint, in any JS engine —
// @polymarket/client's SecureClient.setupTradingApprovals() (viem/ox
// dependencies read on-chain balances and allowances as bigint) triggered
// "Do not know how to serialize a BigInt" on-device. The exact call site
// wasn't traceable through Metro's bundle (wrapping the global JSON.stringify
// reference at runtime never caught it — the caller must hold a captured
// reference, or the crash happens in RN's own bridge/console serialization,
// not the app's fetch layer). This is the standard, safe fix used by every
// RN app that touches BigInt-heavy libraries (viem, ethers): giving BigInt
// a toJSON changes what JSON.stringify calls, regardless of which reference
// is used to invoke it, without needing to find the specific caller.
if (typeof BigInt.prototype.toJSON !== 'function') {
  // eslint-disable-next-line no-extend-native
  BigInt.prototype.toJSON = function toJSON() {
    return this.toString();
  };
}

import 'expo-router/entry';
