# Wallet connection mock — November 7 direction

This local review supersedes the previous create-new / already-have staging and Google design. The latest Reown-inspired direction replaces the email-choice row with an inline **Email** form on the first **Connect to MyBoon** sheet: email input → **Continue**, with **Connect external wallet** secondary below. There is no intermediate email screen. Provider selection belongs to the external adapter, not this sheet. No provider plugin is installed or required.

## Flow

- Connect to MyBoon → inline email field → Continue → Enter code → Paste → Verify → setting up → email-connected wallets.
- Connect external wallet → Approve in your wallet → external connected.
- External identity is generic **External wallet** with a neutral wallet SVG; no provider is assumed.
- Email identity retains the envelope SVG. Paste fills six demo digits (`482193`); Verify remains.
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

All screens are demo states only. Addresses, balances, connections, OTP verification, Copy feedback, and timed transitions are simulated. No authentication, clipboard read/write, adapter connection, wallet creation, or key export takes place.

Export / recovery explicitly previews a simulated Privy handoff, then displays “No keys were exported.” It does not open Privy, show keys, claim export success, or assert security properties. External and unlinked states are guarded from the export path; dock export jumps deliberately select the email-connected demo context.

The existing dark MyBoon palette, bottom-sheet structure, and Wallet background remain. No Wallet tab redesign, network picker, provider chooser, or extra login method is included. Icons are inline SVG; no image assets are referenced. Existing optional web fonts retain system fallbacks.

## Review / handoff

Handoff is **index.html + NOTES.md only**. Old screenshots and capture scripts in the working folder are historical and not part of this handoff. No repository, PR, teammate message, or Mac copy was changed for this pass.

Open `index.html` directly. It starts at Connect to MyBoon (`connect`). The demo dock offers Connect, OTP, Setting up, Connecting, failure states, connected states, export preview states, and Disconnect.

For visual QA: capture the initial sheet, email field, OTP before/after Paste, email-connected dual-chain sheet, generic external-connected sheet, and simulated export entry/end. Check at a mobile viewport that addresses scroll horizontally without wrapping and that Copy stays on the label row. Waiting states auto-resolve after 900 ms (export preview after 1000 ms); capture promptly or pause timers in the reviewing browser.

Programmatic checks use a non-rendering DOM harness, not a browser. Actual rendering, contrast, focus appearance, and horizontal scrolling need parent-led computerUse review before handoff is approved.
