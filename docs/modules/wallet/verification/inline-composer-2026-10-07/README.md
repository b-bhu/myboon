# Inline Swap UI checkpoint — 7 October 2026

## Accepted completion

On 7 October 2026, the user accepted #305 as complete, confirmed that swaps work in their testing, and requested publication and issue closure. The remaining native acceptance paths below are explicitly deferred; closure does not turn them into verified passes.

The final presentation removes raw transaction/RPC failure banners and uses the existing Refresh quote / retry controls. Validation, signing refusal, explicit confirmation and pending recovery remain intact. Unavailable provider fees remain disclosed in Details rather than repeated in the compact summary. Wallet scroll position, panel geometry and corner animation now use Reanimated shared values on the UI thread; React is notified only when the composer coverage boundary changes. The scroll regression fixture has been adapted to that boundary contract.

No tests, typechecks, new device settings, server launches or restarts were run for this final publication at the user's request. The final error-copy and Reanimated revisions have not been rechecked on-device: USB disconnected before comparison. The latest development-build baseline recorded 476 frames, 148 janky (31.09%), median 29 ms and 95th percentile 38 ms during four account scroll-up/down cycles. It is a baseline, not evidence of a performance improvement. Its task-local host captures were cleaned up. Device-side temporary files at `/data/local/tmp/myboon-wallet-smooth-VbTLnh` could not be removed after disconnection.

Implemented the approved Wallet composer in the native app and reused it for routed Spot Swap/Buy/Sell. The latest direct instructions supersede the issue's older Review modal, separate quote strip, Portfolio row and Solana heading label.

The current UI has balances beneath each asset, three decimal places, Pay-only Max/percentage shortcuts, a compact reverse seam, conditional rate/slippage/minimum disclosures, and inline swipe/status/success. The draft stays after success; after 2.4 seconds it returns to a fresh unsigned preview. Reset pauses while a secondary surface is open. Signing still needs a new explicit swipe.

“Details” now opens a centered native dialog containing fees, price impact, slippage tolerance and route. Opening/closing this read-only dialog does not invalidate or re-request a prepared order. The swipe disappears while it is open and cannot return for an expired or mismatched review. Slippage edits and action/session boundaries retain their existing invalidation rules.

Wallet no longer rerenders the composer/controller and account rows on each scroll frame. It changes React state only when the account panel covers/uncover the composer. Animated geometry remains separate from quote/signing logic. Existing #301 navigation/header integration, #304 account rows/data contracts and parallel Meteora work were preserved. No server was launched or restarted for this checkpoint. The user requested the related implementation, fixtures, approved mock and retained evidence be committed and pushed on main.

## Environment and evidence limits

- Earlier native captures used the shared `main` checkout at base HEAD `6f1eae19` with local UI changes. The final scroll baseline used `0b721be1` before the latest Reanimated migration. Unrelated parallel work is outside this checkpoint's ownership.
- Physical OPPO CPH2213, Android 13/API 33, 1080×2400 pixels, density 3: 360 logical pixels wide. This is **not Seeker hardware**.
- Existing `xyz.myboon.app` development client, version 1.0.4/build 5, served by existing Metro 8081 and API 3000. USB reverse mappings reused.
- Real connected wallet used only for UI, balances, quotes and unsigned preparation. This checkpoint made no live signatures or fund transfers.
- Native fixture route: `myboon:///dev-swap-verification?case=confirmed`. It uses generated disposable keys, controlled API/RPC responses and in-memory pending storage; the connected wallet cannot sign from it. Its “confirmed” case means the mocked outcome *if explicitly confirmed*, not an automatic transaction.
- Earlier controlled native fixture confirmations in this run were completed before the user narrowed verification to UI-only. All subsequent checks left signing to the user. The new timed success reset is automated-test verified; its latest native signing/success path is unverified.
- PNGs come from ADB native screen capture; paired XMLs are fresh Android accessibility trees. They are not HTML renders. Accessibility-tree inspection is not a TalkBack user-flow test.
- The device has no `screenrecord` executable. GIF recordings use continuous native ADB screenshots, with timestamps in companion frame JSON files, approximately 2.5 frames/second. They establish the visible interactions, not smoothness at 60 fps, and have no audio.
- A phone call interrupted the final combined token-selection recording attempt. No call controls were operated. Call/lock-screen captures and the interrupted recording were removed; token selection remains unverified natively.

## Native evidence to review

| Evidence | What was observed |
| --- | --- |
| [Before](00-before.png), [current empty Wallet](58-empty-final.png) | Native hierarchy before/after; empty Pay hides rate/slippage/minimum; balances below assets; account tabs below composer. |
| [Typing](50-details-input.png), [ready unsigned preview](53-details-ready.png) | Real connected Wallet `0.001 SOL` input, rate/minimum and unsigned review. Keyboard remains usable while entering input; no swipe while focused. |
| [Details dialog](55-details-dialog-ready.png), [Android Back](56-details-android-back.png), [Close](57-details-close-draft.png) | Native centered dialog, readable fee/route rows and rounded price impact. Back/Close restore the same `0.001 SOL` input and compact composer. The dialog AX tree exposes one Close control and excludes underlying composer controls. |
| [Details interaction recording](54-details-dialog-interaction.gif) | 25.2-second native recording, 66 frames: open Details, Android Back, reopen, Close, retained draft. No confirmation/signing action. |
| [Account panel at header](61-scroll-header-final.png), [AX tree](61-scroll-header-final.xml), [Wallet return](47-wallet-final-return.png) | Panel reaches the header with flat top corners; persistent navigation; covered composer excluded from the AX tree; Wallet return restores the mounted composer. |
| [Buy](16-spot-buy-composer.png), [Sell](17-spot-sell-composer.png) | Existing Spot entries use shared native composer; Buy locks Receive, Sell locks Pay, and routed reverse is disabled. These captures predate the final compact seam/conditional-strip revision. |
| [Single reverse](38-final-single-reverse.png), [double-tap menu](28-double-tap-menu.png), [menu recording](27-gestures-menu-picker-interaction.gif) | One tap reverses/clears input; double tap opens four actions without first reversing. The older recording covers the menu, despite “picker” in its filename; it does not establish token selection. |
| [Empty fixture](34-final-empty-visible.png), [typing fixture](36-final-typing.png), [ready fixture](37-final-ready.png), [UI recording](35-final-ui-interaction.gif) | Empty/reveal/typing/reverse on physical Android, with fixture sign/execute counters zero. Reverse touch bounds are 132×132 physical pixels, or 44×44 logical pixels. |
| [Partial swipe](21-fixture-partial-swipe.png), [first confirmed](22-fixture-confirmed.png), [new draft](23-fixture-next-draft.png), [second confirmed](24-fixture-second-confirmed.png), [earlier fixture recording](19-confirmed-repeat-interaction.gif) | Earlier controlled fixture only: partial swipe submits nothing; each full explicit confirmation increments sign/execute once; input survives success and balances refresh. This predates the latest automatic success reset and does not prove live wallet signing. |

Other numbered artifacts include intermediate repairs; they must not be used as proof of the final UI. Final evidence is selected above. Real quote/balance data can change between screenshots; these images are not an independent chain-balance audit.

## Exact checks and results

Historical commands run from the repository root before the final error-banner removal and Reanimated migration, scoped to the changed features. These results describe those earlier revisions. The adapted scroll fixture and final UI changes were not rerun for publication:

```sh
pnpm --filter hybrid-expo exec tsx --test features/swap/swap.composer.test.tsx
# PASS: 14 tests, 0 failures. Details open/close, stale/expired review,
# draft/order preservation, input focus, timed success reset and modal pause.

pnpm --filter hybrid-expo exec tsx --test features/wallet/wallet-panel-scroll.test.tsx
# PASS: 1 test, 0 failures. No intermediate-frame composer rerenders;
# boundary activation, reset and uninterrupted mounting.

pnpm --filter hybrid-expo exec tsx --test features/swap/swap.controller.integration.test.ts
# PASS: 34 tests, 0 failures. Includes prepared order/session and submission guards.

pnpm --filter hybrid-expo exec tsx --test features/swap/swap.native-fixture.test.ts
# PASS: 6 tests, 0 failures. Controlled fixture outcome/balance behavior.

pnpm --filter hybrid-expo exec tsx --test features/swap/swap.display.test.ts
# PASS: 2 tests, 0 failures. Display precision and atomic balance formatting.

pnpm --filter hybrid-expo exec tsx --test \
  features/swap/swap.math.test.ts \
  features/swap/swap.pending.test.ts \
  features/swap/swap-transaction-validation.test.ts \
  features/swap/swap.api.test.ts \
  features/swap/swap.controller.core.test.ts \
  features/wallet/wallet-action-gesture.test.ts
# PASS: 42 tests, 0 failures. Includes the issue's required focused tests.

pnpm --filter hybrid-expo exec tsc --noEmit -p tsconfig.swap.json
# PASS: exit 0, no diagnostics. No full-repository typecheck.

pnpm --filter hybrid-expo exec eslint \
  features/swap/components/SwapComposer.tsx \
  features/wallet/WalletSecondarySheet.tsx \
  features/wallet/HomeWalletOverview.tsx \
  features/swap/swap.composer.test.tsx \
  features/wallet/wallet-panel-scroll.test.tsx
# PASS: exit 0, no warnings/errors.

git diff --check -- apps/hybrid-expo/features/swap \
  apps/hybrid-expo/features/wallet/HomeWalletOverview.tsx \
  apps/hybrid-expo/features/wallet/WalletActionPanel.tsx \
  apps/hybrid-expo/features/wallet/WalletSecondarySheet.tsx \
  apps/hybrid-expo/features/home/HomeScreen.tsx
# PASS: exit 0, no whitespace errors.
```

React rendering tests print the existing `react-test-renderer` deprecation warning. Mocked React/native-host tests cover state and callback behavior, not native geometry, wallet integration or gesture timing. Unaffected controller/math/pending tests were not repeated after presentation-only edits.

## Lag findings

Source inspection found an avoidable React state update on every Wallet scroll frame. That rerendered the controller and account rows, and recreated animated interpolation nodes. The earlier repair used a ref and memoized animation nodes/handler, with React state only at the coverage boundary; the historical rendering regression verified that revision. The final revision moves continuous scroll animation to Reanimated shared values and retains boundary-only React updates. Its adapted regression fixture has not been rerun.

Earlier native frame counters also show real remaining stutter. The preceding layout's small development-build sample captured **159 frames, 32 janky (20.13%)**, median 21 ms and 99th percentile 69 ms. [Raw sample](scroll-frame-before-native.txt), [scope and checks](scroll-frame-before-native.json).

An additional native-driven transform experiment captured **201 frames, 71 janky (35.32%)**. It did not demonstrate an improvement and was **reverted**. [Experiment sample](scroll-frame-native.json) is diagnostic evidence, not the shipped geometry. Samples included automated scrolling, Wallet-return rendering and ADB/UIAutomator overhead, and had different frame/gesture counts. They are not a controlled causal comparison or release-build benchmark.

Exact native counter commands:

```sh
/Users/bibhu/Library/Android/sdk/platform-tools/adb -s QSYP59UCBUKJNNQC \
  shell dumpsys gfxinfo xyz.myboon.app reset
# Perform two account-panel scroll-up / Wallet-return cycles, no recording.
/Users/bibhu/Library/Android/sdk/platform-tools/adb -s QSYP59UCBUKJNNQC \
  shell dumpsys gfxinfo xyz.myboon.app
```

The overall lag is **not resolved** by this checkpoint. The frame data measures rendering stutter; asynchronous quote preparation can also show a waiting state but has not been established as the stutter's cause. The remaining drawing/animation cost needs a controlled performance trace and release-build comparison. Transaction safety checks were not weakened to reduce waiting time.

## S01–S20 status

This table records the earlier native verification, before the final Reanimated scroll change. “Pass” below means the stated native UI outcome was observed at that revision. “Unverified” means the full scenario needs further native/integration evidence even where automated coverage passes. Direct user revisions apply to S04/S17/S18: inline unsigned review replaces the Review modal, the Portfolio heading is removed, and preparing an unsigned preview is allowed; submission still requires explicit confirmation.

| Scenario | Status | Evidence / remaining path |
| --- | --- | --- |
| S01 Connected entry | **Pass** | Native empty Wallet [58](58-empty-final.png): editable composer, approved hierarchy, balances and reachable account panel. |
| S02 Guest / EVM-only | **Unverified** | Controlled cases implemented and controller checks pass; complete native guest/EVM connection and separation flow not exercised. |
| S03 Balance loading/failure/retry | **Unverified** | Controller/fixture coverage passes. Native retry and data replacement not fully exercised; no fixture values substituted into production. |
| S04 Quote and inline review | **Pass** | Revised UI flow [53](53-details-ready.png), [55](55-details-dialog-ready.png), [recording](54-details-dialog-interaction.gif). Real read-only unsigned preparation and disclosures, no signing. |
| S05 Failure/expiry/out-of-order | **Unverified** | Automated controller and composer expiry/stale guards pass; full native fail/refresh/out-of-order sequence not exercised. |
| S06 Invalid amount / fee reserve | **Unverified** | Focused math/controller tests pass; complete native precision/zero/insufficient reserve matrix not exercised. |
| S07 Token picker | **Unverified** | Final native selection recording interrupted by foreground phone call. Search/loading/empty/error/collision/cancel matrix remains. |
| S08 Single reverse | **Pass** | Native [38](38-final-single-reverse.png), [35 recording](35-final-ui-interaction.gif): pair reversed, Pay remains above Receive, draft cleared. |
| S09 Double tap / cancellation | **Unverified** | Double tap observed in [28](28-double-tap-menu.png) with unchanged draft; automated exclusivity/cancellation passes. Native pending-tap navigation/unmount cancellation still unverified. |
| S10 Menu / Coming soon | **Unverified** | Native four-action menu [28](28-double-tap-menu.png)/[43](43-send-coming-soon.png) labels unavailable actions “Coming soon.” The immediate capture still shows the menu; it does not prove post-selection feedback. Complete Send/Receive/Transfer feedback/draft restoration and TalkBack/keyboard interaction remain. |
| S11 Elevated slippage session | **Unverified** | Typed-confirmation/session tests pass; full native boundary/reopen/pending-trade sequence remains. |
| S12 Prepared invalidation | **Unverified** | Automated amount/pair/wallet/session guards and stale dialog dismissal pass. Full native wallet/network transition/signing refusal matrix remains. |
| S13 Busy / duplicates | **Unverified** | Controller/composer guards pass; native partial swipe submits nothing [21](21-fixture-partial-swipe.png). Complete busy/signing/recovery mutation matrix not exercised. |
| S14 Success / rejection / retry | **Unverified** | Earlier fixture confirmations [22](22-fixture-confirmed.png)/[24](24-fixture-second-confirmed.png); new 2.4-second reset and modal pause covered automatically. Latest native reset/rejection/failure/signing test left to user. |
| S15 Unknown / resume recovery | **Unverified** | Pending/controller automated checks pass. Native background/resume and navigation reconciliation not exercised. |
| S16 Routed Buy/Sell | **Unverified** | Native locked-side presentation [16](16-spot-buy-composer.png)/[17](17-spot-sell-composer.png) passes. Latest routed signing/execution lifecycle left to user. |
| S17 Accounts / tabs / EVM separation | **Unverified** | Spot/Perps panel and draft reachability observed; covered AX fix [61](61-scroll-header-final.xml). Full Meteora/dual-chain data/detail-route matrix not exercised. Existing account data logic preserved. |
| S18 Supported Spot shortcuts | **Pass** | Existing native token-detail Buy/Sell routes [16](16-spot-buy-composer.png)/[17](17-spot-sell-composer.png) open the allowed locked token in shared composer, no submitted transaction. |
| S19 Layout / focus / accessibility | **Unverified** | Physical 360px keyboard and Details/Back checks pass [50](50-details-input.png)/[55](55-details-dialog-ready.png)/[56](56-details-android-back.png). 390px, iOS, TalkBack, reduced-motion setting and larger text not verified. User excluded the Android font-change/reload issue. |
| S20 Validation / simulation refusal | **Unverified** | Automated refusal/acknowledgement coverage passes; supplied screenshot shows route-state safety refusal. Latest full native refusal/explicit unavailable acknowledgement matrix not exercised. Safety refusal retained. |

## Specific remaining checks

- Live external/embedded wallet approval, rejection and repeat-swap signing are assigned to the user; no agent live transfers were performed.
- Actual Seeker hardware, iOS and 390px device/emulator access were not available in this run. No font-size settings were changed.
- TalkBack, reduced-motion device setting, full token-picker matrix, elevated-slippage session transitions and unknown/pending resume require further device evidence.
- The supplied “Writable route state has no owning program…” refusal is a transaction-validation path. This presentation change does not fix or bypass that backend/route problem.
- Remaining scroll stutter requires profiling; the earlier rerender reduction was verified, but the final Reanimated revision and an overall performance improvement are unverified.
- The complete requested combined interaction recording remains incomplete (token selection is missing). Native Details, keyboard/reveal/reverse, double-tap menu and earlier controlled confirmations are recorded separately, with their limits above.

The issue now publishes the complete design at commit `638bb65343f3681ecfc1641f667ca1f680e50150` on `codex/home-redesign-references-301`; its ZIP is no longer required. The existing canonical `docs/mockups/home-redesign/wallet-inline.html` reference was reused. No new HTML mock was created.
