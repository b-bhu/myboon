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

import 'expo-router/entry';
