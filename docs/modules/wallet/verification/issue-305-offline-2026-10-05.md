> Historical offline checkpoint, 2026-10-05. Superseded by [the current native report](issue-305.md).

# Issue 305 implementation and verification

Implementation is in the working checkout. Native acceptance is **unverified**. No native screenshots or interaction recording were produced: no Android device, installed Android emulator, or available iOS simulator was accessible, and the requester authorized **existing servers only**. There is an existing API on port 3000, but no Metro listener on port 8081. No server was launched or restarted.

## Specification and preserved work

- [#305 — Swap redesign — inline Wallet composer](https://github.com/b-bhu/myboon/issues/305), read again on 2026-10-05. Its last update was `2026-10-05T15:35:46Z`; comments were empty. The inline design supersedes the earlier Wallet bottom sheet.
- [#301 — Home layout redesign](https://github.com/b-bhu/myboon/issues/301) is the parent; [#304 — Wallet redesign](https://github.com/b-bhu/myboon/issues/304) supplies accounting and account-content contracts. Their current bodies/comments were read. This checkout lacked the destination shell and `HomeWalletOverview`, so this change supplies the minimal host integration and reuses existing account rows/providers.
- The supplied ZIP was eventually located at `/tmp/myboon-swap-handoff-305.zip`. Extraction into `/tmp/myboon-305-reference/myboon-swap-handoff-305/` found the HTML, CSS, JavaScript and wordmark. The three source files match the [published, immutable reference](https://github.com/b-bhu/myboon/tree/638bb65343f3681ecfc1641f667ca1f680e50150/docs/mockups/home-redesign) byte for byte. Retrieval used GitHub's contents API; it did not switch branches or overwrite checkout files.
- [Published handoff and retrieval instructions](https://github.com/b-bhu/myboon/blob/638bb65343f3681ecfc1641f667ca1f680e50150/docs/mockups/home-redesign/HANDOFF.md) make the reference accessible from another checkout. Local `docs/mockups/home-redesign/` files remain intact. Browser automation rejected the local-file URL; no bypass or rendered reference image is claimed.
- Base commit: `b34460ef6f9ed83cc602836f7ffe0de70f8eec09`, branch `main`. The implementation revision is the commit containing this report. No PR, deployment, or native build was created.
- Pre-existing changes in `CLAUDE.md`, issue-writing instructions/templates, `AGENTS.md`, `apps/web/next-env.d.ts`, `apps/video/src/party-conversation/`, and mock files were preserved. Every file under `apps/hybrid-expo/features/meteora/` matched its pre-edit SHA-256 snapshot; no Meteora positions, funding, adapters, or execution were edited.

## Three checkpoints

1. **Shared controller — implemented; offline checks pass.** `useSwapController` owns balances, composition, quoting, preparation, validation, simulation, approval, execution and wallet-scoped recovery. Routed Swap/Buy/Sell retain their routes and locked sides. Route focus suspends inactive controllers. Changes invalidate prepared orders; elevated slippage and acknowledgements reset across session boundaries. Pending transactions retain exact reviewed amounts and never auto-resubmit.
2. **Wallet integration — implemented; native behavior unverified.** Controlled `AssetSwap`, picker and review components separate presentation from the controller. Wallet has the gold upper area, dark inline composer, quote strip, compact portfolio row, raised account panel and persistent navigation. Existing Spot/Phoenix/Pacifica/Meteora rows and data hooks remain. Single reverse resolves after 300 ms; double reverse opens only the four-action menu. The visible dropdown provides the same menu. Send/Receive/Transfer show Coming soon and preserve Swap's draft. Home, avatar and Swap use the one app-wide connection sheet.
3. **Verification — offline work complete; native evidence blocked.** The actual React hook is exercised with controlled service/platform doubles. Failures found during extraction and lifecycle checks were repaired and retested. Device gestures, rendering, keyboard/focus, provider handoffs and native recordings remain blocked as listed below.

## Evidence boundary and setup

Host: macOS 15.7.3 (`24G419`), Node `v24.10.0`, pnpm `10.28.0`. Tests run from `apps/hybrid-expo`. `react-test-renderer` and its types were added as dev dependencies, matching React 19.1.0; no runtime dependency was added.

`features/swap/swap.controller.fixture.ts` is Node-only and is not imported by the application or selectable in a production build. It mounts the actual production hook in React and replaces native storage, RPC, quote/execution services, wallet callbacks and validation/simulation boundaries. It uses memory pending storage, disposable generated keys/transactions, 3 SOL and 1,000 USDC fixture balances, deterministic order disclosures, delayed/out-of-order responses and explicit approval/execution/error outcomes. The tests set fixture fields directly; there is no server, production account, credential, provider approval or live fund movement. The existing transaction-validation tests independently use generated test keys and `FakeConnection` to check transaction integrity and simulation constraints.

The hook tests establish controller transitions, calls and persistence under those doubles. They **do not** establish provider SDK behavior, real backend execution, native gestures/layout or Solana settlement. There is no configured native UI fixture build in this run; the Node fixture cannot be selected on a device.

Useful defects reproduced and repaired:

- Controller extraction initially referenced an acknowledgement callback before initialization, causing a hook-mount exception.
- Busy same-tick mutations could invalidate an in-flight preparation instead of being ignored.
- A cancelled preparation/approval could remain stuck busy; an old wallet's rejected balance read could clear the new wallet's balances.
- A context change while saving a signed pending record could still submit it. The new guard removes an unsubmitted record and prevents execution.
- Unmount during approval and wallet switching during execution needed distinct cancellation/recovery guards. Submitted records remain scoped to their original wallet; old work cannot publish into a new session.
- The routed screen was always active, and Home mounted a second connection sheet. Source audit found and repaired both integration defects.

[First lifecycle regression run](issue-305-evidence/lifecycle-before-repair.txt) recorded four failures; [unmount/wallet-switch reproduction](issue-305-evidence/context-before-repair.txt) recorded two failures. These are historical repair evidence, not final results. The final 42-case controller/session/gesture run below passes all of them, including cancelled unresolved preparations and manual status-check failure recovery.

## Exact checks

All commands below run from `apps/hybrid-expo` except `git diff --check`, which runs from the repository root. Logs are adjacent in `issue-305-evidence/`. Final results are recorded after the final repair run.

```sh
pnpm exec tsx --test features/swap/swap.math.test.ts features/swap/swap.pending.test.ts features/swap/swap-transaction-validation.test.ts
```

Result: **29 passed, 0 failed**, exit 0. [Required swap log](issue-305-evidence/required-swap.txt).

```sh
pnpm exec tsx --test features/swap/swap.controller.integration.test.ts features/swap/swap.controller.core.test.ts features/wallet/wallet-action-gesture.test.ts
```

Result: **42 passed, 0 failed**, exit 0: 30 actual-hook integration cases, 3 session/rate cases and 9 gesture scheduler cases. [New regression log](issue-305-evidence/controller-and-gestures.txt). React's test-renderer deprecation warning is emitted; these are controller tests, not native rendering tests.

```sh
pnpm exec tsx --test features/wallet/wallet.refresh.test.ts features/wallet/dormantBalance.test.ts features/wallet/components/connect.options.test.ts features/wallet/components/connect.filtering.test.ts
```

Result: **37 passed, 0 failed**, exit 0. [Wallet regression log](issue-305-evidence/wallet.txt).

```sh
pnpm test:chain
```

Result: **72 passed, 0 failed**, exit 0. This script runs only `features/chain/chain.test.ts`, `activation.test.ts` and `deferredCreation.test.ts`. [Chain regression log](issue-305-evidence/chain.txt).

```sh
pnpm exec tsc --noEmit --pretty false -p tsconfig.swap.json
```

Result: **passed**, exit 0, no diagnostics. Scope covers Swap, its new Wallet/Home host components and their imported contracts; no repository-wide check was run.

```sh
pnpm exec eslint features/home/HomeScreen.tsx features/home/components/HomeNavigation.tsx features/wallet/HomeWalletOverview.tsx features/wallet/WalletSecondarySheet.tsx features/wallet/WalletActionPanel.tsx features/wallet/wallet-action-gesture.ts features/wallet/wallet-action-gesture.test.ts features/swap/SwapScreen.tsx features/swap/useSwapController.ts features/swap/components/AssetSwap.tsx features/swap/components/SwapTokenPicker.tsx features/swap/components/SwapReview.tsx features/swap/components/SwipeToConfirm.tsx features/swap/swap.display.ts features/swap/swap.theme.ts features/swap/swap.controller.core.ts features/swap/swap.controller.core.test.ts features/swap/swap.controller.fixture.ts features/swap/swap.controller.integration.test.ts components/AppTopBar.tsx components/AvatarTrigger.tsx
git diff --check
```

Result: **both passed**, exit 0; ESLint has no errors or warnings. [Static-check log](issue-305-evidence/static-checks.txt). Across the four scoped test commands above, **180 tests passed**, with no failed/skipped/cancelled tests.

## S01–S20 acceptance table

Statuses apply to the **whole requested scenario**, including native interaction where specified. Supporting offline passes are listed separately; they do not convert an unobserved native scenario into a pass. No final offline failure is being accepted as complete.

| Scenario | Status | Supporting evidence and remaining check |
| --- | --- | --- |
| S01 Connected entry | Unverified | Empty defaults pass in all hook modes. Host/layout implemented. Needs connected native Wallet hierarchy and screenshots. |
| S02 Guest / EVM-only | Unverified | Guest hook cannot sign and offers Solana connection; existing connection/dormancy tests pass. Needs guest/EVM-only native fixture sessions and EVM/Solana separation observation. |
| S03 Loading / unavailable balances | Unverified | Hook balance failure, reserve, retry and stale-wallet isolation checks pass; account source/refresh checks pass. Needs visible loading/stale/error/retry states on device. |
| S04 Quote and review | Unverified | Actual hook checks current quote/order, explicit review, validation/simulation, and zero signing/execution before confirmation. Decimal-normalized rate has an independently specified expected value. Needs native quote-strip and complete review disclosure inspection. |
| S05 Quote failure / expiry | Unverified | Out-of-order/cleared-input and expiry checks pass; source provides retry/refresh. Needs native unavailable/error/expiry/retry exercise with deterministic API responses. |
| S06 Invalid input / reserve | Unverified | Required math tests and hook reserve/balance refusal checks pass. Needs specific native validation states for precision, zero, insufficient assets and SOL reserve. |
| S07 Token picker | Unverified | Hook search ignores late responses; same-mint collision invalidates and clears amount. Source exposes loading/empty/error/retry with Pay/Receive title. Needs native search/select/cancel/focus check. |
| S08 Single reverse | Unverified | Deterministic scheduler tests prove one deferred single callback. Hook reverse clears pair draft/quote. Needs actual native tap timing and recording. |
| S09 Double / cancellation | Unverified | Exclusive double/triple/cancel/busy/dispose/latest-callback tests pass. Source cancels on surface/focus/session transitions. Needs actual native double tap, Back/unmount and recording. |
| S10 Visible menu / unavailable actions | Unverified | Four IDs checked; source labels dropdown, announces Coming soon and leaves controller draft/slippage untouched. Needs native accessibility/dropdown and all three unavailable actions observed. |
| S11 Slippage session | Unverified | Typed CONFIRM, session reset and no restored order/acknowledgement pass in hook tests; 50% cap covered by math tests. Pending reviewed amounts retained. Needs native settings/session/action/tab and pending interaction check. |
| S12 Prepared invalidation | Unverified | Hook tests cover input, stale callbacks, wallet change, leave/return and routed token context. Source routes token/pair/slippage mutation through invalidation. Needs native wallet/network/surface/draft restoration checks. |
| S13 Busy / duplicate actions | Unverified | Same-tick prepare/confirm mutation and duplicate execution checks pass. Unknown recovery blocks fresh preparation. Needs repeated native taps across real approval and recovery surfaces. |
| S14 Success / rejection / retry | Unverified | Mock approval, exactly one execution, confirmed refresh, rejection and definite failure pass. No actual wallet approval/SDK/backend settlement was performed. Needs controlled native provider flow and result UI. |
| S15 Unknown outcome | Unverified | Memory-store startup/expiry/manual/resume/navigation recovery, original reviewed parameters and wallet isolation pass. No automatic resubmission. Needs native app background/resume and configured provider/API recovery. |
| S16 Routed Swap / Buy / Sell | Unverified | Hook modes and locked-side picker checks pass; existing `app/swap.tsx` and token-detail routes preserved. Routed focus now gates controller. Needs native navigation/locked-side/confirmation regression. |
| S17 Portfolio / account tabs | Unverified | Existing rows/providers reused, measured/unknown totals and chain separation retained in source; wallet and chain tests pass. No Meteora files changed. Needs real-data native tabs/detail/portfolio return and geometry evidence. |
| S18 Spot shortcut | Unverified | Existing Spot `onTrade` still pushes `/swap` with mode and mint; shared controller preselects only that allowed asset. Needs native Spot → Buy/Sell → return observation. |
| S19 Layout / sheets / focus | Unverified | Native Modal/keyboard avoidance/reduced-motion handling and accessible 44px controls implemented. No device observation at 360/390px, large text, screen reader or keyboard; focus restoration remains unverified. |
| S20 Validation / simulation refusal | Unverified | Existing transaction-integrity/FakeConnection tests pass; actual-hook simulation refusal and unavailable acknowledgement prevent signing. Needs native warning/acknowledgement and external/embedded provider refusal display. |

## Native evidence blockers and remaining work

| Required path | Actual status |
| --- | --- |
| Before/after native Wallet screenshots, full hierarchy and composer close-up | Not produced; no device/runtime. The baseline was inspected and saved as source only. |
| Single/double tap, visible menu, token selection, review and return recording | Not produced; no native runtime. No HTML or simulated recording substituted. |
| Android at 360px / 390px | No `adb` devices. Android SDK emulator directory contains only installer metadata, no runnable emulator. Device/OS/dimensions/build are unavailable. |
| Seeker hardware | Unavailable; no connected device. |
| iOS simulator | `xcrun simctl list devices available` returned no devices. |
| External MWA wallet | Native provider unverified; Node wallet callback double only. |
| Embedded Privy wallet | Native provider unverified; source/session switch only, no SDK login/signing exercise. |
| Pending recovery and validation/simulation | Offline controlled checks pass; native/provider/backend paths unverified. |
| Keyboard, Android Back, large text, screen reader, reduced motion | Implemented hooks/labels/layout are source-reviewed; actual behavior unverified. |
| Controlled native UI fixtures | Node fixture exists; no device fixture build or safe provider/API environment was configured in this run. Existing API health alone proves neither fixture support nor trade behavior. |

[Native environment observations](issue-305-evidence/native-environment.txt) record the actual read-only commands and outputs. [Meteora preservation check](issue-305-evidence/meteora-preservation.txt) records all baseline checksum results.

The saved [pre-edit Meteora checksums](issue-305-evidence/meteora-baseline.sha256) can be checked from the repository root:

```sh
shasum -a 256 -c docs/modules/wallet/verification/issue-305-evidence/meteora-baseline.sha256
```

To finish acceptance, provide an already-running configured native development build with a controlled API/provider fixture environment and Android devices/emulators at the required widths. Do not enable live transfers. Capture matched before/after native images and the requested interaction recording, then run each scenario above and update its status with device, OS, logical dimensions, build/commit, fixture case and attempt evidence. The current implementation must not be described as fully native-verified before those checks.
