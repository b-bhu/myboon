# Selected home direction — C

## Start here for remote development

Read [HANDOFF.md](HANDOFF.md) for GitHub references and fetch/extraction instructions that work on a VPS without the original laptop or a local ZIP.

| Scope | Current reference |
| --- | --- |
| Shared shell, Feed and Apps (#301–#303) | `index.html`, `home.css`, `home.js` |
| Wallet and Swap (#304–#305) | `wallet-inline.html`, `wallet-inline.css`, `wallet-inline.js` |

The Wallet inside `index.html`, its older Swap sheet, and the A/B/C Swap alternatives are historical. Their files remain so reference links resolve; they are not the implementation target for #304/#305. Use the latest live GitHub issue for acceptance scope. All HTML content remains illustrative and non-executing.

Open `index.html`. This is the selected HTML prototype. Earlier Home concepts, screenshots and temporary design scripts have been removed. Three new Swap explorations are available in `swap-concepts.html`; the selected mock keeps its approved Swap while these alternatives are reviewed. This work does not implement the Expo screens or connect live services.

The palette follows `apps/hybrid-expo/theme/tokens.ts` and `apps/hybrid-expo/features/feed/feed.constants.ts`. Developing stories retain the compact cards already used on native Home. Native body type, restrained Avenir headings and small mono captions retain C’s visual identity.

## Color roles

- **Frame:** deep teal `#073B4C`, with navy `#031F2C` for navigation and chart surfaces.
- **Reading:** darker teal `#082D39` for Stories; greener teal `#033744` for other information cards and app launchers. Subtle `#185A70` borders define their edges.
- **Calendar:** navy `#031F2C` holds the always-open agenda; its left date panel uses card teal `#033744`. Event titles use soft white `#F5FAFC`, with times and asset context in secondary `#9CB8C2`.
- **Text:** headlines use `#F5FAFC`, body text uses `#9CB8C2`, and metadata blends faint `#6B95A1` 70/30 with secondary text for contrast.
- **Interaction:** gold `#FFD166` marks reading links, primary actions, small section labels, the current Story timeline marker and keyboard focus. The active bottom tab uses card teal, bright text/icons and a subtle border.
- **Data:** blue `#118AB2` supports charts. Liquidation intensity runs from navy through blue to cool white.
- **Direction:** green `#06D6A0` and readable pink `#FF95AF` indicate positive/negative values; transaction amounts retain explicit buy/sell labels.
- **Protocol identity:** original app marks and wallet allocation colors remain distinct.

## Home layout

1. **Developing stories:** a horizontal compact carousel with current development, miniature timeline and Full story action.
2. **Latest updates:** heading above the lead card, with All updates on the right. The card has a wide image, headline, summary, time and source.
3. **Calendar:** an outside heading and All events action above a full-width, always-expanded agenda with equal 50/50 panels and a fixed 250px height. A teal panel on the left selects Day or Week, shows the date or range and moves to the previous/next period. The dark right panel lists CPI, earnings, PPI and a token unlock with scheduled times and related assets; the event list scrolls inside the card. Week is the initial view; tapping an event opens its detail.
4. **Smart wallet activity:** an outside section heading above a full-width watched-wallet transaction card, below Calendar. Wallet identity and action sit to the left, the amount to the right.
5. **Token stats:** an outside heading above the full-width Bitcoin card. Home ends here.

The section headings identify the information type; the card interiors carry the actual information. There are no continuation cards or Load more button on Home. All updates still opens the full newest-first reporting list, with native Home’s 190px lead image, 106px side thumbnails and a readable fallback for reports without content images.

Find/search has been removed. The header now has a notification bell and account icon. The bell opens an empty Notifications preview and returns to the current destination without losing reading position. No live notifications or unread counts are simulated.

## Apps direction

Apps uses a two-column launcher grid for Polymarket, Pacifica, Phoenix and Meteora. Each card shows the original logo, name, purpose and one Open app action. The grid can add rows as more apps arrive. Existing overview routes still illustrate each app’s wallet access; no app interiors were redesigned.

## Wallet reference from the native app

Wallet now reproduces the existing overview in `apps/hybrid-expo/features/home/HomeScreen.tsx`, using the styles and structure of `WalletHero.tsx`, `WalletActivityTiles.tsx`, `components/ChainRow.tsx`, `WalletAccountRow.tsx` and `PerpsAccountRow.tsx`. This is the current Wallet placed inside the selected navigation shell, ready for a later design discussion. No Expo implementation or wallet provider code was changed.

- Wallet starts 12px below the app header, with its navy destination background and native card surfaces. The oversized Wallet heading and its 120px block have been removed; the overview moves up 108px while the navigation and accessible section label identify the destination.
- The hero has its native freshness/refresh row, 39px total and 6px protocol allocation bar. Its total covers Solana protocol accounts; Polygon is displayed separately.
- Swap, Send, Receive and Transfer retain their compact native tiles. Send, Receive and Transfer show Coming soon on tap. Swap opens the Bencho-style preview described below. Account-row taps explain that their destinations are outside this overview preview. The controls carry their existing app routes in metadata.
- Solana and Polygon rows show native name/address/balance styling, copy and Disconnect controls. Addresses are illustrative truncated examples; copy does not write a fake wallet address to the clipboard.
- Spot uses overlapping fallback token chips. Meteora uses position pills, in/out-of-range rings and a fees line. Phoenix and Pacifica use position pills and arrows colored by unrealized PnL. Protocol identity uses the app's colored names and faint tints, without added dot badges or section headings.
- The disconnected card retains the app's copy and Connect wallet action. Connection and confirmation are simple prototype detail views; the native bottom sheet and sign-in flow are outside this overview reference.

The mock initially opens Wallet with the Both-connected sample. The **Wallet preview** selector sits outside the app and offers Guest, Solana, Polygon, Both, syncing, stale and failed states. Selecting a state opens Wallet. Syncing balances retain skeletons and an unknown chain balance; stale values remain visible with Retry; a failed first load is excluded from the total. Retry/refresh resolve sample balances only. The Both fixture models two Privy-backed chains, so its disconnect confirmation clears both; the Solana-only fixture models an external wallet.

To open directly in the connected overview, append `?nav=wallet&wallet=both` to the local `index.html` URL. All monetary values remain illustrative fixtures.

## Swap preview

Wallet's Swap action now opens a bottom sheet over the mounted Wallet, with a dimmed backdrop, 20px rounded top corners and a maximum height of 92% of the app frame, matching the existing native sheet's geometry. The Bencho composer and its colors remain unchanged. Two separate 28px rounded teal panels hold amounts and fiat values on the left, token pills on the right and a reverse control on their seam. The selected panel grows into its own searchable picker; the other panel squeezes away. Reduced-motion preferences remove the sheet and picker transitions. This is vanilla HTML/CSS/JavaScript; no React, Framer Motion or icon dependency was installed.

- Pay remains above Receive. Reversal and token changes clear the amount, matching the current native controller. Choosing the other panel's asset exchanges the two assets.
- Amount editing and 25/50/100% shortcuts use sample balances. Integer token arithmetic retains decimal precision and the native 0.005 SOL fee reserve.
- The local picker contains SOL, USDC, JUP, BONK and WIF fixtures with names, balances and search. Marks are inline illustrations/fallbacks; this list does not represent live token coverage.
- Minimum received and Auto/0.5%/Custom slippage are illustrated with a local sample conversion. Auto uses a 0.5% assumption in this mock only. Quotes omit provider/routing costs and are never live or signable. Slippage above 15% requires the existing CONFIRM-style acknowledgement before opening the review.
- Review shows an explicitly non-executing summary and Back to swap. Signing, swipe-to-confirm, submission and transaction recovery remain outside this mock. No wallet account, provider or application source is connected or modified.
- The sheet's close button or backdrop dismisses it, leaving Wallet at the same scroll position and returning focus to Swap. Escape first closes an open picker or review, then dismisses the sheet. Background controls are inert while the dialog is open, focus stays inside its visible controls and long content scrolls within the sheet.

## Swap design alternatives

### Wallet with inline Swap

The latest experiment is `wallet-inline.html`, linked as **Try Wallet with inline Swap** from `index.html`. It takes the token-left/amount-right hierarchy from C and places the action directly on Wallet in place of the large total balance. The action heading and default Swap card are approximately 258px high by their CSS sizing, about 31% of the 844px reference screen; rendering has not been measured. Yellow `#FFD166` runs across the full width from the header through the swap and portfolio area, ending at the account switcher. The dark navy working card stays inset. The header wordmark, icons, heading, quote details and portfolio use navy on yellow; card amounts use soft white with secondary blue-white labels. Rate, editable slippage and minimum received remain immediately below the card.

Swap is the default. A single pointer click on Reverse waits 300ms before reversing; a second within that window cancels the reversal and opens Swap / Send / Receive / Transfer without clearing the amount. Keyboard activation reverses immediately. The visible action-name menu opens the same choices, so the gesture is optional. Drafts survive action changes. Send adds a recipient address, Receive shows account/address information, and Transfer uses source/destination accounts with a USDC amount. These are local sample forms and non-executing reviews; address validation is format-only and not chain validation.

The portfolio total is a compact row that opens account details. Below it, the entire navy markets panel overlaps the yellow section by 24px and has 14% top-left and top-right corner radii with a soft upward shadow. The Spot / Perps / Meteora control sits inside this panel, centered at 80% width, with a 26px outer radius and 20px button radii. A separate inner tabpanel updates the market contents while keeping the account controls mounted. The selected item is a filled yellow pill. Spot shows markets and holdings totaling $8,420; Perps shows Phoenix/Pacifica positions and $1,650 of account equity; Meteora shows two liquidity positions totaling $2,412.56. Rows open details. A Spot detail can load that asset into Swap; a Perps detail can open Transfer for the corresponding account. The combined Solana total is $12,482.56, with Polygon shown separately. Feed and Apps open the selected reference screens, and their Wallet navigation returns to this experiment when entered from it.

The experiment supports `?embed=1`, reduced motion, keyboard-operated account tabs, and dialog focus trapping/return. Its HTML, CSS and JS are isolated in `wallet-inline.*`. No native app implementation or wallet execution is connected.

### Earlier bottom-sheet alternatives

Open **Compare three Swap designs** in the selected mock, or open `swap-concepts.html` directly. The comparison shows three independent GPT-6.1 Sol/high explorations. Each opens Swap over the same sample Wallet total and four-action structure; the original Swap remains in `index.html`.

- **A — Paired cards:** separate, equally weighted Pay and Receive cards; full-width amounts and an open rate/reverse row.
- **B — Pay first:** a large editable Pay amount, compact Receive summary and an anchored review action in one connected surface.
- **C — Asset first:** token identity on the left, equally weighted amounts aligned right and Reverse in the sheet header.

Each standalone file supports `?embed=1` and includes decimal amount editing, local token selection, reversal, balance shortcuts, configurable sample slippage, a non-executing review, close/reopen and modal focus handling. These concepts use SOL/USDC samples; B and C also offer JUP. Custom slippage is limited to 5% for these previews. No live quotes, signing or transaction services are connected.

## Prototype behavior

- Swipe/trackpad, Tab and arrow keys move between Stories. Full story opens the corresponding detail, and returning preserves the selected Story and vertical feed position.
- The desktop Queue 2 sample updates control stages a report and observed wallet transaction. Queuing preserves visible content. Applying replaces the Latest and activity previews and updates the Story timeline; Home still ends at Token stats.
- All updates opens reporting separately from Stories and token datasets.
- Calendar mode and selected period survive event details, Back, Close and destination changes. Day shows that day's events; Week shows Monday–Sunday in time order. Periods without fixtures show an empty agenda. Event saves are independent, in-memory preview state; no reminder service is connected. All events opens the full sample schedule.
- BTC/SOL and map periods illustrate a limited initial token set without claiming provider coverage.
- Feed, Apps and Wallet remain one tap away. Back and Close preserve destination context.
- Wallet preview states show combined Solana value and separate Polygon funds, with the existing native overview structure. No authentication or transactions are connected.

All headlines, dates, wallets, transactions, prices, balances and charts are illustrative fixtures. Editorial images illustrate reports; they are not documentary images or live charts. Calendar and smart wallet activities remain planned features represented by samples.

Files: `index.html` (review frame and app shell), `home.css` (selected design), `home.js` (fixtures and navigation), `swap.css` / `swap.js` (approved Swap preview), `wallet-inline.html` / `wallet-inline.css` / `wallet-inline.js` (inline action experiment), `swap-concepts.html` (comparison), `swap-concept-a.html` / `swap-concept-b.html` / `swap-concept-c.html` (standalone alternatives), `assets/` (the required logo/editorial files) and this README.

## Verification

The inline Wallet experiment passed scoped JavaScript syntax, static IDs/labels/local-link checks and offline fixture/state checks. These cover quote/minimum precision, balance and fee-reserve limits, single/double-tap distinction, unchanged amounts when opening the action menu, token collision, all four action modes, saved Swap drafts, Send/Transfer validation, non-executing reviews, dialog inert cleanup, account tabs and portfolio totals. Checks use a document stub, not a layout engine. Its rendered layout, keyboard overlap and touch timing still need visual/device review; local-file browser automation remains blocked. No server or screenshots were created.

The Wallet heading removal passed JavaScript syntax and scoped markup/spacing checks. All three new Swap alternatives passed script execution and fixture checks for quote/minimum precision, invalid amounts, balance limits, the SOL fee reserve and reversed pairs. Agent interaction checks also covered token selection/search, balance shortcuts, slippage, review and modal close/reopen/focus behavior. The comparison and all three alternatives passed checks for unique IDs, label references, local dependencies and dialog markup. These are offline checks with a lightweight document stub; rendered layout and animation remain unverified because local-file browser automation is blocked. No server, install or screenshots were involved.

Earlier scoped browser checks passed at 360×800, 390×844 and 1440×1000 using local file URLs and the installed browser. Checks covered removal of Find and Home continuation, external section headings and the former compact Calendar/activity pair, notification return and focus, Story selection preservation, updates-list navigation, queue/apply replacement without extending Home, the two-column Apps grid, all four app launchers, existing Wallet chain separation, text contrast, assets, tap targets, unique IDs and horizontal overflow. Those checks predate the expanded Calendar revision.

The expanded Calendar passed JavaScript syntax and offline interaction checks for day/week filtering, date navigation, empty periods, event routes, independent saves, Back/Close, destination state and scroll, year and leap-day boundaries, generated markup/assets and text contrast. These checks use a lightweight document stub, not a browser layout engine. The revised layout has not been visually rechecked in the browser.

The native Wallet reference passed JavaScript syntax and offline interaction checks for connection/source states, separate totals, action/account metadata, retry/refresh, external versus shared Privy disconnect behavior, destination scroll restoration, preview selection and direct opening. Feed, Apps and their existing detail markup remained identical to the previous mock. These checks use a document stub; Wallet's rendered layout has not been visually verified because browser policy blocks local file pages. No server was started and no screenshots were generated for this pass.

Swap passed syntax and offline interaction checks for quote precision, balance limits/SOL reserve, token search, picker/morph state, same-asset selection, reversal, custom slippage acknowledgement, non-executing review, Back/Escape and Wallet scroll restoration. Wallet, Feed and Apps continue producing identical overview markup. The checks use a document stub and do not verify browser layout or animation; local file preview remains blocked by browser policy. No server, install or screenshot was involved.

The bottom-sheet revision passed focused offline checks for opening without replacing Wallet's DOM, retained scroll, inactive background navigation, focus trapping/return, picker/review Escape, close/backdrop dismissal and cleanup after changing the preview state. The composer markup remains identical; only its heading gained the sheet's close control. Sheet dimensions/animation have not been visually checked in a browser.

Mobile Home’s lower sections, Apps and desktop Home were visually inspected before cleanup. The review captures and earlier design files were then removed; the current HTML, CSS, JavaScript and all required assets were preserved byte-for-byte. No application source files, including the parallel Meteora work, were changed during cleanup. No local servers, installs, commits or deployments were involved.
