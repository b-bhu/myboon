# Wallet connection mock — November 7 direction

This local review supersedes the previous create-new / already-have staging and Google design. The latest Reown-inspired direction replaces the email-choice row with an inline **Email** form on the first **Connect to MyBoon** sheet: email input → **Continue**, with **Connect external wallet** secondary below. There is no intermediate email screen. Provider selection belongs to the external adapter, not this sheet. No provider plugin is installed or required.

## Flow

- Connect to MyBoon → inline email field → Continue → Enter code → type or Paste → Verify → setting up → email-connected wallets.
- Connect external wallet → Approve in your wallet → external connected.
- External identity is generic **External wallet** with a neutral wallet SVG; no provider is assumed.
- Email identity retains the envelope SVG. OTP is now one editable six-digit input with numeric keyboard and one-time-code autocomplete. Paste fills demo digits (`482193`); Verify / Enter validates six digits before simulated setup.
- Email-connected Privy sheet: Solana + EVM, Export / recovery, Disconnect.
- External-connected sheet: Solana only and Disconnect; no export action.
- Every chain label has Copy aligned right. The complete sample address is one unbroken monospace line below, horizontally scrollable, never ellipsized.
- Manage opens the matching connected sheet; when unlinked it opens the inline-email Connect to MyBoon sheet.
- Login failure retries email sign-in. Setup failure retries wallet setup without restarting login; the failure demo includes Log out and start over after three simulated failures.

- Email form uses a visible label, required email type, email inputmode/autocomplete and a submit button; pressing Enter submits. Empty or invalid email shows a short inline error and stays on the first sheet.
- Draft email is preserved across back/close; OTP Back always returns to the initial sheet with that value. Login retry returns to the same form; setup retry still bypasses login.
- Input, Continue, external entry and sheet Close have at least 44px touch targets. Address scrollbars use muted teal track/thumb styling. Global phone dimensions/scaling were not changed.
- Reown references informed inline-email placement only; no social/provider lists, badges, or reference images ship.

## Demo boundaries

All screens are demo states only. Addresses, balances, connections, OTP verification, Copy feedback, and timed transitions are simulated. No authentication, actual email sending, clipboard read/write, adapter connection, wallet creation, or key export takes place.

Export / recovery explicitly previews a simulated Privy handoff, then displays “No keys were exported.” It does not open Privy, show keys, claim export success, or assert security properties. External and unlinked states are guarded from the export path; dock export jumps deliberately select the email-connected demo context.

The existing dark MyBoon palette, bottom-sheet structure, and Wallet background remain. No Wallet tab redesign, network picker, provider chooser, or extra login method is included. Icons are inline SVG; no image assets are referenced. Existing optional web fonts retain system fallbacks.

## Export instructions (latest review)

Export / recovery now shows three numbered steps, not a paragraph:

1. Sign in to Privy using the **same email** used for MyBoon (email is the current login method).
2. Open **My Apps**, then **MyBoon**.
3. Choose the wallet and follow Privy’s export instructions.

“My Apps → MyBoon” is the user-provided navigation path, not independently verified provider UI. No exact later Privy button names are invented. The compact warning now reads “Keep your private key to yourself.” No “MyBoon never sees it” claim is made. **Continue with Privy**, **Not now**, and Back remain. This is a simulated handoff only; the end screen still states that no keys were exported.

## OTP resend / lifecycle

- **Resend code** is secondary beside Paste, near the code/destination, with ≥44px touch targets. The editable code input is 56px high; Verify remains primary.
- `DEMO_RESEND_SECONDS = 30` and `DEMO_SEND_MS = 700` are configurable illustrative demo timings, not factual Privy limits or email-delivery guarantees.
- Initial send/resend shows sending feedback, then sent/resent feedback in a polite live region; the button is disabled during sending/cooldown with a visible seconds countdown. Repeated taps are guarded in the handler as well as disabled in UI.
- Deadlines use absolute time. Back/close/state changes clear the interval; reentry retains the same email, code, and remaining deadline instead of restarting it. New email resets the code/session. Pagehide stops ticking; pageshow restores only one ticker. Once expired, the ticker stops.
- No email is sent. Production must use authentication-service request state, server retry deadlines / rate limits, success/failure responses and recipient/session identity—not this client demo timer. Delivery failures need a service-backed error and retry state; this mock simulates success only.
- Native email/code form semantics and inline validation remain. The sheet body scrolls at short heights; dynamic viewport sizing and keyboard resize hint help preserve access. Actual mobile keyboard layout still requires visual/device review.

## Wallet sheet exclusions

Privacy Policy, Terms of Service, and Delete Account were **not present in the live scratch HTML**, so no legal/account rows were fabricated or removed. Intended implementation direction: omit all three from the wallet sheet. This pass does not redesign settings/account management or change production files. No swipe/drag gesture changes were made.

## Review / handoff

Handoff is **index.html + NOTES.md only**. Old screenshots and capture scripts in the working folder are historical and not part of this handoff. No repository, PR, teammate message, or Mac copy was changed for this pass.

Open `index.html` directly. It starts at Connect to MyBoon (`connect`). The demo dock offers Connect, OTP, Setting up, Connecting, failure states, connected states, export preview states, and Disconnect.

For parent computerUse visual QA: start at `connect` (default / Connect dock); submit email for `otp`, or use OTP dock. Capture editable code, inline invalid-code error, Paste, countdown-disabled Resend, enabled Resend after 30 seconds, then sending/resent feedback. Use Export dock or Connected · Privy → Export / recovery to inspect numbered instructions, warning, Continue / Not now, then simulated end. Also check initial email, connected dual-chain and external Solana-only remain intact. Check at a mobile viewport that addresses scroll horizontally without wrapping and that Copy stays on the label row. Waiting states auto-resolve after 900 ms (export preview after 1000 ms); capture promptly or pause timers in the reviewing browser.

Programmatic checks use a non-rendering DOM harness, not a browser. Actual rendering, contrast, focus appearance, and horizontal scrolling need parent-led computerUse review before handoff is approved.

Verification for this pass: JavaScript parsed successfully; 268 non-rendering DOM assertions passed with a fake clock, including initial/resend cooldowns, repeated taps, Back/close/reentry, pagehide/pageshow cleanup, code/email validation, all state links/handlers, separate retries and export guards. No browser automation or new screenshots were used.

## Latest export refinement — OTP unchanged

The export-entry sheet no longer contains “Simulated handoff only” or any demo disclaimer paragraph. Simulation remains a developer-only boundary here and in the honest post-handoff demo end state (“No keys were exported”). Continue with Privy still simulates navigation; it does not export secrets.

Exact entry content:
1. Sign in to Privy with your **MyBoon email**.
2. Open **My Apps** → **MyBoon**.
3. Choose your wallet and follow the export instructions.

Warning: **Keep your private key to yourself.**
Actions: **Continue with Privy** / **Not now**, plus Back.

### Claim verification / limitation

Requested product wording “MyBoon never sees your private key” remains an intended requirement, not a verified implementation fact. It is **not asserted** in the mock.

Official sources read:
- https://docs.privy.io/recipes/mobile-key-export — documents an app-hosted React export page in a mobile WebView; states key assembly occurs on a separate origin and neither app nor hosted page accesses the full key.
- https://docs.privy.io/wallets/wallets/export — React client export documents separate-origin isolation, but the same page also documents server-side exports returning plaintext keys. The isolation statement is flow-specific, not proof of every implementation.
- https://docs.privy.io/recipes/dashboard/recovering-assets — concerns developer-dashboard asset recovery and says no key export is needed; this is **not** end-user Privy Home / My Apps export documentation and cannot establish the desired claim.
- https://docs.privy.io/llms.txt — official index inspected for applicable dashboard documentation.

The official Privy Home blog URL https://privy.dev/blog/enhanced-wallet-controls-in-privy-home timed out; the blog.privy.io variant returned HTTP 525. No available official source established the specific Home → My Apps → MyBoon flow’s isolation together with MyBoon’s actual implementation. No repository or secrets were inspected. Therefore safe warning copy is used; do not turn SDK-only evidence into an absolute MyBoon promise.

### Export fit / accessibility

Export-only layout uses 16px step text at 1.45 line height, 12px step spacing, a one-line 14px warning, and a compact action group (52px primary / 44px secondary). It removes duplicate helper text, rather than shrinking type or hiding content. Export homebar is 8px and existing bottom padding remains max(20px, safe-area-inset-bottom). A state attribute scopes these changes to export; OTP styles, markup, validation, resend/paste and timer logic were checked byte-for-byte unchanged.

Conservative non-browser font-metric estimates using installed Inter plus 10% width allowance and a 34px safe area: approximately 432px export sheet content/chrome at all nine combinations of widths 360/390/440 and heights 740/844/956. Available sheet heights are approximately 546/642/730px respectively. This predicts normal-size fit, **not measured browser overflow**. Existing overflow:auto is intentionally retained as an accessibility fallback for enlarged text / very short screens, with no overflow:hidden clipping or global scroll disabling.

Parent computerUse must confirm actual export `.sheet-bd` scrollHeight ≤ clientHeight and all text/actions visible at the nine target combinations after fonts load; also check safe-area inset and enlarged-text fallback. No screenshots or browser automation were produced for this pass.
