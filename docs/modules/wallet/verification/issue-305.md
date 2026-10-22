# Issue 305: implementation and native verification

> Screenshot and log evidence for this report was removed from the repository in PR #423 (it stays in git history).

Updated **2026-10-06**. The inline implementation is committed in `c63813977493a84028d68e9b45a7bfe8430b6e75`; the follow-up repair and evidence are in the revision containing this report. **Acceptance is incomplete: 9 pass, 2 fail, 9 unverified.** Passing controlled native cases do not establish real wallet approval or Solana settlement.

The connected wallet and Jupiter credentials work for read-only balances and quotes. Two defects were reproduced and repaired: Reverse had a clipped native touch target, and the API requested JupiterZ routes that the existing signing safeguards reject. The local API repair reached native Review; the hosted API has not been deployed with it. A routed Buy preparation and live system-font changes remain failed paths.

The requested `fix-and-verify` skill was unavailable; the installed `verify-feature-flow` workflow was applied: reproduce, bound repairs, verify real UI outcomes and retain explicit limits.

## Specification and preserved integration

[#305](https://github.com/b-bhu/myboon/issues/305) was reread on October 6; updated `2026-10-05T15:35:46Z`, no comments. Its inline Wallet design supersedes the earlier bottom sheet. [#301](https://github.com/b-bhu/myboon/issues/301) remains the parent navigation contract, and [#304](https://github.com/b-bhu/myboon/issues/304) supplies accounting/account contents. The minimal Wallet host reuses existing Spot, Phoenix, Pacifica and Meteora providers and routes.

The supplied ZIP was found at `/tmp/myboon-swap-handoff-305.zip`. Its three source files matched the [immutable design artifact](https://github.com/b-bhu/myboon/tree/638bb65343f3681ecfc1641f667ca1f680e50150/docs/mockups/home-redesign). [Published retrieval instructions](https://github.com/b-bhu/myboon/blob/638bb65343f3681ecfc1641f667ca1f680e50150/docs/mockups/home-redesign/HANDOFF.md) work outside this laptop. PR #306 is the design-reference PR, **not an implementation PR created for these changes**.

Pre-existing issue-writing instructions, `CLAUDE.md`, web typings, video work and mock files were preserved. Every file in `apps/hybrid-expo/features/meteora/` still matches the original checksum baseline; the final comparison passes. No protocol execution, funding or positions were edited.

## Three checkpoints

1. **Controller reuse:** one shared hook owns composition, quote/order preparation, transaction validation, simulation, confirmation, signing, submission and wallet-scoped pending recovery. Routed Swap/Buy/Sell retain their modes and locked sides. Prepared orders and acknowledgements are invalidated on context changes; restored drafts cannot arm a trade.
2. **Inline Wallet:** gold upper area, navy inline composer, quote strip, compact Solana portfolio row, raised account panel and persistent navigation. Single Reverse resolves after 300 ms; double Reverse opens only the four-action menu. The visible dropdown exposes the same actions. Send/Receive/Transfer remain Coming soon and preserve the draft. Presentation stays separate from financial I/O.
3. **Verification and repairs:** actual Android screenshots, gestures, routed entries, large text and disposable native confirmation/recovery were exercised. The clipped Reverse seam was expanded to a real 48×48 dp target. The API now adds server-owned `excludeRouters=jupiterz` to both quote and signable requests and retains refusal if the provider returns an unsupported signer layout anyway. This parameter is supported by [Jupiter's order contract](https://developers.jup.ag/docs/api-reference/swap/order).

Controller extraction defects repaired during the original checkpoint and its 180 passing offline tests remain documented in [the historical report](issue-305-offline-2026-10-05.md). The follow-up adds injectable service boundaries and a controlled view that reuses the production controller and Wallet presentation, plus a dev-only native fixture screen. Production callers retain their normal dependencies.

## Environment and safety boundary

- macOS 15.7.3, Node 24.10.0, pnpm 10.28.0. Existing Metro on port 8081 and existing API on port 3000 were used. **No server was manually launched or restarted.** The existing API watcher reloaded itself after the source edit.
- Connected physical **CPH2213 / OP4F4DL1**, Android 13 / API 33, 1080×2400 pixels, density 480: **360×800 logical pixels**. This is not verified Seeker hardware. Installed app `xyz.myboon.app`, version 1.0.4 / code 5, Expo SDK 54 development client; JavaScript loaded from this checkout over the existing Metro.
- Supplied wallet `7iNJ…Vo9C` remained connected and logged in. Native account identity and a public RPC balance of **40,749,602 lamports** matched the UI's 0.040749 SOL. See account and read-only balance oracle.
- Local `JUPITER_API_KEY` / API `JUP_API_KEY` were populated, non-placeholder and matched without printing them. Upstream requests returned 200. Provider route oracle established Metis, gasless=false and the wallet as the only required signer; local unsigned order also returned 200. No transaction bytes or credentials were saved in those artifacts.
- Real-wallet checks stopped at Review or a refusal. **No real wallet signing, provider approval, submission or fund transfer occurred.** A separate unsigned RPC simulation succeeded, but it was not the same attempt as the earlier native simulation refusal; its log does not explain that refusal.
- During local integration, only the mobile API URL was temporarily changed to `http://localhost:3000` with USB forwarding. It has been restored to its original hosted URL, preserving other current env settings. Port 3000 forwarding was removed. The 8081 USB bridge remains so the existing Metro connection continues to work. Font scale 1.0, TalkBack off, original animation scales and physical display size were restored. See cleanup, settings and final Wallet.

### Disposable native fixtures

In a development build, open `myboon:///dev-swap-verification?case=confirmed`. The visible banner says **LOCAL FIXTURE · NO REAL FUNDS**. Case buttons or the whitelisted query select:

`solana`, `guest`, `evm-only`, `dual`, `balances-loading`, `balances-failed`, `quote-failed`, `quote-expired`, `quote-out-of-order`, `approval-rejected`, `confirmed`, `execution-failed`, `unknown-recovery`, `validation-refused`, `simulation-refused`, `simulation-unavailable`.

Every controller wallet/signing, balance, quote/order, search/price, validation/simulation, execution, refresh and pending-storage dependency is replaced. Signing uses a freshly generated disposable key and an empty disposable transaction; execution returns local data. Confirmed totals correspond to the exact prepared request ID and atomic amounts. The screen cannot use the connected wallet to sign or submit. The route disables activation outside `__DEV__`; this is not a claim that the fixture source is absent from the production bundle.

App-level real hooks/providers still mount and may hydrate existing account/read-only state. Fixture `evm-only` and `dual` model Solana connectivity only; they do not provide genuine EVM account/provider coverage. Balances and execution are controlled expectations, not actual settlement. Pending storage is in memory, so process-death/disk recovery remains a separate check. **Suspend surface**, **Resume surface** and **Mark pending confirmed** exercise controlled recovery. Visible counters track orders, signing, execution and refresh.

## Native evidence

All PNGs are actual phone pixels from ADB `screencap`; matching XML files are native accessibility trees where available. UIAutomator was not used while TalkBack was enabled because its default automation mode suppresses accessibility services. Pixels and device-service state alone do not certify audible labels.

- Before Reverse repair / after: native target grew from 44×12 to 48×48 dp. Upper-edge retest reversed once and cleared the amount.
- Full Wallet, empty connected entry, live Review, large-text Wallet, large-text keyboard and large-text action menu.
- Requested interaction recording: 67.18 seconds, 177 native frames, single reverse, exclusive double-tap menu, visible menu alternative, token selection, Review and return to the fixture composer. Frame timestamps and 97 ms double-tap input timing are separate. The phone blocks Android `screenrecord`; this is a roughly 2.6 fps frame recording without audio and cannot establish fine animation/gesture timing. It reuses Wallet's presentation inside the fixture screen; it does not show the gold Wallet host throughout.
- Disposable confirmation recording shows native confirmation/result/return. The final retest after fixture instrumentation shows success and one execution / one refresh.

No pre-#305 native Wallet screenshot was available: the device was connected after the implementation commit. The before/after pair documents the touch-target repair, not the historical bottom-sheet-to-inline redesign. The old source baseline and design artifact remain available; no HTML screenshot substitutes for native evidence.

## Exact automated checks

From `apps/hybrid-expo`:

```sh
pnpm exec tsx --test features/swap/swap.math.test.ts features/swap/swap.pending.test.ts features/swap/swap-transaction-validation.test.ts features/swap/swap.controller.integration.test.ts features/swap/swap.controller.core.test.ts features/wallet/wallet-action-gesture.test.ts features/swap/swap.native-fixture.test.ts
```

**73 passed, 0 failed**, exit 0. Log. This run included the first two native-fixture tests; it predates the final telemetry/totals assertions.

```sh
pnpm exec tsx --test features/swap/swap.native-fixture.test.ts
```

Final fixture revision: **4 passed, 0 failed**, exit 0. Log. The 30 actual-hook integration cases also passed after the dependency/callback repairs. React test-renderer emits its deprecation warning; those checks do not prove native rendering.

From `packages/api`:

```sh
pnpm exec tsx --test src/swap.test.ts
```

**17 passed, 0 failed**, exit 0, observed after the router exclusion repair. Full output was not retained; no second run was performed solely to recreate a log.

From `apps/hybrid-expo`:

```sh
pnpm exec tsc --noEmit --pretty false -p tsconfig.swap.json
pnpm exec eslint features/swap/useSwapController.ts features/swap/components/AssetSwap.tsx features/wallet/WalletActionPanel.tsx features/swap/swap.controller.dependencies.ts features/swap/swap.native-fixture.ts features/swap/swap.native-fixture.test.ts features/swap/SwapVerificationScreen.tsx app/dev-swap-verification.tsx
pnpm exec eslint features/swap/SwapVerificationScreen.tsx features/swap/swap.native-fixture.ts features/swap/swap.native-fixture.test.ts
```

All exit 0; no type diagnostics, lint errors or warnings. The final scoped typecheck was repeated after the final fixture totals/telemetry change and passed. Static results.

From the repository root:

```sh
git diff --check
```

Both exit 0. The original checkpoint's focused Wallet/refresh/connection command passed **37** cases, and `pnpm test:chain` passed **72** cases. Exact historical commands/logs are in [the dated report](issue-305-offline-2026-10-05.md). They were not needlessly rerun. No full-repository suite or broad typecheck was run. Counts across repeated commands overlap and must not be summed as unique tests.

## S01–S20 table

**Pass** means the described case was observed on this phone, with a controlled fixture where explicitly indicated. **Fail** records an observed blocked/broken path. **Unverified** includes partially exercised cases whose remaining branch lacks evidence. Offline coverage is supporting evidence, not a replacement for native observation.

| Scenario | Status | Evidence and practical limit |
| --- | --- | --- |
| S01 Connected entry | Pass | Empty editable Wallet, full hierarchy; real connected account/balance remain reachable. |
| S02 Guest / EVM-only | Unverified | Guest / EVM-only fixture show connection and unavailable balance. Genuine EVM/dual-chain separation and provider switching were not exercised. |
| S03 Balances loading / unavailable | Unverified | Failure / retry passed. Initial native balance loading shows a dash, then existing data resolves. Loading with valid input and unresolved/stale prices remains unverified. |
| S04 Quote and Review | Pass | Real unsigned Review, complete fixture disclosures, Review with sign=0/execute=0. Real provider approval remains outside this case. |
| S05 Quote failure / expiry / late result | Pass | Native controlled quote failure, expiry, refresh. Newer 0.02 SOL input retains 3 USDC after both replies; quote=2, order/sign/execute=0. |
| S06 Invalid input / reserve | Pass | Native zero, precision, insufficient funds, 0.005 SOL reserve blocked Review. |
| S07 Token picker | Unverified | Real USDC search, cancel preserves draft, mint collision clears amount observed. Empty/error/retry and full focus restoration remain unverified. |
| S08 Single Reverse | Pass | Native upper-edge retest and recording: one reversal, Pay stays above Receive, amount clears. |
| S09 Double / cancellation | Unverified | Exclusive double menu and recording/timing passed. A single tap followed by dropdown activation completed inside 142 ms; the menu opened, and 0.01 SOL / USDC remained intact after the timer window. Input timings. Actual unmount cancellation remains covered offline only. |
| S10 Visible menu / unavailable actions | Unverified | Visible four-action menu and native Send, Receive, Transfer feedback preserve 0.01 SOL and Swap. Visible-pointer activation passed; keyboard/TalkBack activation and focus navigation remain unverified. |
| S11 Slippage session | Unverified | 16% blocked without CONFIRM; typed acknowledgement, tabs preserve tolerance, leave/return resets Auto. Elevated-slippage pending-trade parameters were checked offline, not in the native recovery attempt. |
| S12 Prepared invalidation | Unverified | Native pair/token change clears draft/quote; hook tests cover amount/slippage/context changes and stale orders. Real wallet/network changes while a native Review is prepared were not exercised. |
| S13 Busy / duplicate actions | Unverified | Controlled native outcome counters show no duplicate execution, and unresolved recovery persists. Repeated native mutations during each preparation/SDK-approval phase remain unverified; focused hook/gesture coverage passes. |
| S14 Success / rejection / failure | Pass | Disposable native success + refresh=1, approval cancelled / zero execution, definite execution failure + Refresh. One execute after approval, zero after cancellation. This is mocked signing/execution, not real SDK/settlement. |
| S15 Unknown recovery | Pass | Controlled unknown state, actual background/resume, suspend/resume, confirmed recovery with execute=1. Process-death/disk persistence, real RPC/provider recovery and wallet switching remain unverified. |
| S16 Routed Swap / Buy / Sell | Fail | Actual Spot → Buy JUP quote/locked Receive then “Writable account evidence is unavailable”. Sell locks Pay and quotes, opens Review. Routed lifecycle is not fully accepted; no real confirmation occurred. |
| S17 Portfolio / account tabs | Unverified | Perps and Meteora preserve amount/16% slippage and use existing rows. Real EVM totals, all protocol detail routes and their loaded/error states remain unverified. |
| S18 Spot shortcut | Pass | Actual Spot JUP Buy/Sell actions select only JUP on the appropriate locked side; return to editable inline Wallet. Navigation did not auto-review, sign or submit. S16 separately records the Buy preparation failure. |
| S19 Layout / sheets / focus | Fail | 360 dp normal, 160% text after reload, keyboard and reduced-motion menu observed. Changing font scale on the running app clipped text until reload. 390 dp override denied. TalkBack service state, native Wallet focus and menu focus captured; audible labels and full return/focus traversal are not certified. |
| S20 Validation / simulation refusal | Pass | Native strict unsupported signer refusal, simulation failure, controlled validation/simulation refusals, unavailable warning blocks confirmation until explicit acknowledgement. Real external/embedded signer integrity remains unverified; core generated-transaction tests pass. |

## Remaining blockers and failed paths

1. **Hosted API:** local JupiterZ exclusion is not deployed. Restoring the original hosted API does not deliver that server fix to the phone's usual environment. Deployment remains outside this task's authorization.
2. **Routed Buy:** writable-account evidence was missing for the observed SOL → JUP prepared route. The strict guard correctly stopped signing. Its account/route root cause is not isolated. `readAccountInfos` collapses RPC lookup errors and absent accounts to the same null value; the refusal identifies neither the address nor which case occurred. Exact writable-account/RPC evidence from the failing attempt is needed. Weakening validation is not a repair.
3. **Live font change:** text clipped until full reload across Feed, Wallet and navigation. Stable large-text layout worked after reload; this does not resolve the live change failure. Read-only inspection of the installed RN 0.81.5 / Expo 54 Fabric runtime found `enableFontScaleChangesUpdatingLayout` disabled: its surface reports a fixed font scale and configuration changes skip the layout-metrics refresh. This matches the cross-screen stale bounds, but a definitive repair requires an isolated native feature-flag/upgrade experiment and rebuilt-client verification at 1.0↔1.6. Do not remount trade controllers during signing to hide it.
4. **390 dp / Seeker / iOS:** device policy denies display overrides with `WRITE_SECURE_SETTINGS`; no matching second device/emulator or iOS runtime was available. The connected handset is CPH2213, not established Seeker hardware.
5. **TalkBack / keyboard focus:** TalkBack was genuinely enabled with touch exploration and native green focus rectangles captured. Its OEM watermark/onboarding and injected tap/swipe behavior prevented reliable full traversal/return assertions. No audible output was available. Human-operated TalkBack gestures and speech checks remain required.
6. **External / embedded wallets:** the existing connected external-wallet read-only context works; actual MWA approval/rejection, embedded Privy signing, real account/chain switching, submission and settlement were not tested. Safe SDK fixtures/provider instrumentation are needed to complete those checks without live fund movement.
7. **Native evidence completeness:** no historical pre-redesign native screenshot; recording is low-frame-rate and the main interaction recording uses the disposable host. Stale/superseded captures are excluded from acceptance claims. Remaining native valid-input loading/search-error/unmount-gesture/prepared-context branches are explicitly unverified above.

The implementation and repaired local flows are reviewable, but the issue must not be called fully verified or ready to merge based only on offline tests or these partial native passes.
