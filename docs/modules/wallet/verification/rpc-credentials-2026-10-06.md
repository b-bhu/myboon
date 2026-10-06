# Backend credential migration — 2026-10-06

Jupiter already uses the backend `/swap` gateway. The remaining phone credentials were in the public Helius and Alchemy RPC URLs. Solana, Solana devnet and Polygon now use `/rpc/solana`, `/rpc/solana-devnet` and `/rpc/polygon` on the app's existing API base URL. Solana subscriptions use `ws`/`wss` on the same API port.

The backend owns provider URLs/keys. The wallet still signs on the client. Wallet, Swap, Pacifica, Meteora and Predict now use the gateway; Meteora changes are limited to RPC configuration and its optional WebSocket endpoint. Quote/order validation, signer checks, confirmation, slippage limits, duplicate prevention and pending recovery remain intact. The existing JupiterZ exclusion stays in place: [Jupiter's managed flow](https://developers.jup.ag/docs/swap/order-and-execute) allows a market maker to co-sign after wallet partial signing; the current MyBoon validator supports a single wallet signer.

The HTTP proxy has a method allowlist, batch/request/response limits, timeout, per-source quota and credential redaction. It forwards signed broadcasts exactly once without signing, caching or retrying them. The WebSocket bridge forwards subscriptions and unsubscribes, charges upgrades, bounds queued/buffered data and closes failed connections. Incoming provider-key/auth headers are not forwarded. Proxy-header trust is disabled by default and requires an explicit deployment setting.

The Expo config rejects public provider keys, old public RPC overrides and credential-bearing URLs in public environment/manifest fields. Public Privy and Turnkey IDs remain public configuration. Per-wallet Polymarket authentication credentials retain their existing user-auth behavior. Release preflight now checks all three RPC HTTP routes before publishing an app.

## Environment and observations

- Connected CPH2213 / OP4F4DL1, Android 13, 1080×2400 pixels / 360×800 dp; app `xyz.myboon.app`, Expo SDK 54 development client. This is not a verified Seeker device.
- Wallet: `7iNJ7CLNT8UBPANxkkrsURjzaktbomCVa93N1sKcVo9C`. Existing login/wallet session was retained. No wallet signing, execution, deposit, transfer or other fund movement was performed.
- Used the existing API on port 3000. Its source watcher reloaded automatically. The user explicitly approved **one restart of the existing Metro on 8081** after its old process kept injecting retired public RPC values into the bundle preamble. Removing `.env` entries alone did not clear that process. A fresh process passed both config and bundle checks.
- Ignored local API `.env` now owns the existing Helius/Alchemy URLs. Ignored mobile `.env` contains no public RPC variables and points to `http://localhost:3000`; ADB forwards 3000 and 8081. Metro remains running for local testing. No private env values, full credentialed URLs or transaction bytes are saved in this evidence.
- The initial phone draft was 0.0089374 SOL → USDC. Full JS reload cleared the in-memory draft; the same pair/amount was restored manually, then restored again after the opposite-direction check. [Final device state](rpc-credentials-evidence-2026-10-06/13-final-restored-wallet.png).

## Outcomes

| Check | Result | Evidence / limit |
| --- | --- | --- |
| Jupiter requests use only the server credential | Pass, automated + real read-only | All six client operations use `/swap`; server credential/header and routing-policy tests pass. Real native quote and unsigned Review succeeded. |
| Public credentials are rejected by Expo/release config | Pass, automated | Four Expo-fence tests and two release-log/URL tests; clean actual local Expo config also passed. |
| Actual Android development bundle contains no known configured credentials | Pass | [Memory-only bundle scan](rpc-credentials-evidence-2026-10-06/android-bundle-credentials.json). Tests actual populated server credential values, including RPC keys embedded in URLs. It does not certify unknown cloud/build credentials or a release APK. |
| Solana mainnet/devnet HTTP reads | Pass, real read-only | [RPC smoke](rpc-credentials-evidence-2026-10-06/rpc-smoke.json): blockhash, wrapped-SOL account ownership and balance. Gateway wallet balance equalled a separate direct provider read: 40,749,602 lamports. [Account-creation rent read](rpc-credentials-evidence-2026-10-06/rpc-rent-read.json) also matched the direct provider. |
| Polygon HTTP reads | Pass, real read-only | Same smoke: chain ID 137, block number and read-only USDC contract decimals call. |
| Solana mainnet WebSocket subscription lifecycle | Pass, real read-only | Same smoke: same-port upgrade, slot notification and unsubscribe acknowledgement. Devnet/production reverse-proxy WebSocket transport remains unverified. |
| Proxy failure/broadcast/abuse boundaries | Pass, fixtures | Fake HTTP and socket tests cover failed/malformed/oversized/timed-out responses, exact single broadcast forwarding, spoofed quota headers, queue flush, cleanup, backpressure and invalid upgrades. No test servers/listeners or real broadcast payloads. |
| Native SOL → USDC Review through gateway | Pass, native read-only | [Quote](rpc-credentials-evidence-2026-10-06/05-restored-draft-quote.png), [Review](rpc-credentials-evidence-2026-10-06/07-native-review-result.png), [reviewed fees/route and confirmation control](rpc-credentials-evidence-2026-10-06/08-native-review-validation.png). Prepared 0.0089374 SOL → 1.076636 USDC, minimum 1.074913 USDC, 0.16% slippage, TesseraV 100%. Stopped before confirmation/signing. This does not prove submission or on-chain success. |
| Native USDC → SOL preparation / earlier writable-account failure | Unverified | [1 USDC quote and disabled Review](rpc-credentials-evidence-2026-10-06/09-usdc-sol-quote.png). [Independent RPC read](rpc-credentials-evidence-2026-10-06/native-buy-blocker.json) found one USDC account with amount `0`. No funded Buy preparation was possible; the earlier writable-account failure is not claimed fixed. |
| Hosted RPC availability | Fail / rollout blocked | [Hosted statuses](rpc-credentials-evidence-2026-10-06/hosted-rpc-status.json): all three routes returned 404. Local success does not establish hosted availability. |

[Native interaction recording](rpc-credentials-evidence-2026-10-06/06-native-rpc-review.gif) contains 132 actual ADB screencaps over 49.99 seconds (about 2.64 fps), resized to 360×800, without audio or synthetic frames. [Frame timestamps](rpc-credentials-evidence-2026-10-06/06-native-rpc-review-frames.json), accessibility XML next to each screenshot, and [interaction inputs](rpc-credentials-evidence-2026-10-06/attempts.jsonl) support the native observations. This is a GIF recording, not Android `screenrecord` video.

The original #305 [S01–S20 table](issue-305.md) remains the historical full-feature verification. This follow-up does not reclassify its unverified execution/session/device scenarios. Font-size changes remain outside this request.

## Exact scoped commands and results

From `packages/api`:

```sh
pnpm exec tsx --test src/swap.test.ts
# 19 passed, 0 failed
pnpm exec tsx --test src/rpc/routes.test.ts src/rpc/websocket.test.ts
# 13 passed before the parent added an invalid-upgrade regression
pnpm exec tsx --test src/rpc/websocket.test.ts
# Final WebSocket file: 5 passed
pnpm exec tsx --test src/rpc/routes.test.ts
# Final HTTP file: 10 passed after adding account-creation rent coverage (15 distinct RPC tests)
pnpm exec tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --skipLibCheck src/rpc/policy.ts src/rpc/routes.ts src/rpc/websocket.ts src/rpc/routes.test.ts src/rpc/websocket.test.ts
# Passed; parent also checked RPC implementation + both helper scripts after edits
pnpm exec tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --skipLibCheck scripts/verify-rpc-gateway.ts scripts/verify-client-bundle.ts
# Passed
pnpm exec tsx scripts/verify-rpc-gateway.ts http://localhost:3000 7iNJ7CLNT8UBPANxkkrsURjzaktbomCVa93N1sKcVo9C
# 6 real read-only checks passed
pnpm exec tsx scripts/verify-client-bundle.ts http://localhost:8081
# Passed: Android dev bundle had no configured Jupiter/Helius/Alchemy credential values
```

From `apps/hybrid-expo`:

```sh
pnpm exec tsx --test features/swap/swap.api.test.ts
# 1 passed
pnpm exec tsx --test lib/rpc.test.ts features/meteora/meteora.sdk-client.test.ts features/swap/swap.controller.integration.test.ts
# 38 passed
node --test scripts/client-secrets.test.cjs
# 4 passed
node --test scripts/production-endpoint-secrets.test.cjs
# 2 passed
pnpm exec tsc --noEmit -p tsconfig.swap.json
# Passed
pnpm exec eslint app.config.js scripts/verify-production-endpoints.mjs features/swap/swap.api.test.ts
# Passed (release script checked again after URL/log hardening)
pnpm exec eslint lib/rpc.ts lib/rpc.test.ts features/perps/pacific.config.ts features/perps/PacificaDepositModal.tsx providers/WalletProvider.native.tsx providers/WalletProvider.web.tsx features/swap/useSwapController.ts features/swap/swap.controller.fixture.ts features/predict/predict.signing.ts features/meteora/meteora.config.ts features/meteora/meteora.form-execution.native.ts features/meteora/meteora.form-execution.web.ts features/meteora/meteora.position-actions.native.ts features/meteora/meteora.sdk-client.test.ts
# Passed; providers checked again after stabilizing the connection-config objects
```

79 distinct focused automated cases passed, plus six real RPC smoke checks and a separate read-only rent comparison. Full repository suites were not run. A bootstrap-inclusive API typecheck attempted by the backend worker reached pre-existing errors in entity commands, Polymarket, tokens and collectors; it is not reported as a clean package check. Root/shared ESLint is unavailable; the targeted app/shared SDK tests and relevant scoped typechecks passed.

## Rollout and remaining checks

1. Configure server-only `JUP_API_KEY`, `SOLANA_RPC_URL` (or compatible `HELIUS_RPC_URL`) and `POLYGON_RPC_URL` in the hosted API. Keep `HELIUS_RPC_URL` configured for the existing `/spot` wallet asset service even if the new proxy uses a separate `SOLANA_RPC_URL`. Optional devnet and WebSocket URL overrides also remain server-only. Deploy the backend before releasing this client. No deployment or push was performed here.
2. Ensure the production reverse proxy forwards WebSocket upgrades for `/rpc/solana` and `/rpc/solana-devnet` to the same API server. Set `TRUST_PROXY_HEADERS=true` only behind an edge that overwrites forwarding headers and prevents direct worker access; otherwise keep the default connection-address policy. All app clients behind an untrusted shared edge can share that edge's quota.
3. Remove retired public RPC/Jupiter variables from EAS/cloud/local build environments and restart any old bundler process before exporting. Remote EAS variables and release APK contents were not inspected. Run the existing `pnpm release:api` preflight after hosted deployment and the read-only RPC smoke against the hosted URL; it must also pass the WebSocket lifecycle check.
4. Rotate/revoke previously shipped Helius/Alchemy keys through the provider accounts after coordinating the backend/client rollout. Cleaning source or a fresh bundle does not revoke credentials in old APKs. Historical Jupiter key exposure should also be reviewed. Rotation was not performed.
5. Funded Buy preparation, the previous writable-account refusal, actual wallet signing, submission/pending recovery, complete native Meteora/Predict/Pacifica execution and Seeker-specific behavior remain unverified. No live-fund checks are implied by the passing fixtures or read-only results.
