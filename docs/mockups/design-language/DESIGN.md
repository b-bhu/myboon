# MyBoon Design Language

Rules every screen follows. Change a rule here first, never ad hoc in code. Colours come only from `apps/hybrid-expo/theme/tokens.ts`.

## Progress
- [x] 1. Colour roles
- [x] 2. Typography
- [x] 3. Spacing and layout
- [x] 4. Shape and depth
- [x] 5. Icons
- [x] 6. Motion and haptics (haptics done; motion timing with components)
- [x] 7. Cards
- [x] 8. Carousel
- [x] 9. Tabs
- [x] 10. Buttons
- [x] 11. Swipe-to-confirm
- [x] 12. Bottom sheet
- [ ]
- [x] 13. Forms
- [ ] 14. Alerts and toasts · 15. Notifications · 16. Wallet connect and signing · 17. Loading, empty, error
- [ ] 18. Screens: Feed, Apps, Wallet

## 1. Colour roles
Each tab has its own identity and structure; components are shared.
- **Feed** (reading): screen `walletCore` #031F2C, story cards #073B4C, glance/calendar cards `ground` #063343.
- **Apps** (action hub): screen #073B4C, cards #083D50, icon tiles `lift` #0A4A60. Blue `primary` #118AB2 only on the Apps top band.
- **Wallet** (holding): gold `accent` #FFD166 floods the header; dark scroll panel below.
- **Gold accent, restrained:** only small action links and the bottom tab bar's active icon and label, in every tab. Never fills outside Wallet's header.
- **Text:** `bone` primary, `dim` secondary, `faint` labels/captions.
- **Meaning:** `viridian` up/positive, `vermillion` down/negative. Never as decoration.
- **Borders:** `border` #185A70 hairline.
- Blue or green as a general accent is not allowed.

## 2. Typography
- Text: system font (Roboto on Android). No custom font.
- Numbers (prices, balances, %): monospace.
- Small labels and timestamps: monospace, uppercase, 1px letter spacing, `faint`.

| Size | Use |
|---|---|
| 34 | Big numbers (balance, swap amount), mono bold |
| 28 | Screen title, once per screen |
| 20 | Section headers |
| 18 | Card titles |
| 15 | Reading text |
| 14 | Secondary text, list values |
| 12 | Captions, sources, links |
| 11 | Mono capital labels and timestamps |

No other sizes.

## 3. Spacing
Only 4, 8, 12, 16, 24, 32.
- Screen edge margin 16 · card padding 12 · between cards 12 · between sections 24.

## 4. Shape and depth
- Cards 8 · buttons and app tiles 6 · bottom sheet top corners 12 · chips 4.
- 1px hairline border on cards, tiles, sheets. No shadows. Depth comes from the background ladder.

## 5. Icons
- Thin outline, 1.6 stroke, square ends. Selected tab icon and label turn gold; others `faint`.
- Prefer icons over text labels where meaning is clear.

## 6. Haptics
Vibrate only on: trade or send confirmed; swipe-to-confirm completes; pull to refresh. Nothing else.

## 7. Cards
- Always boxed: lift colour of the tab, 1px border, 8 corners. Never unboxed lists.
- Compact layout: title (18) first, optional one-line text (15), then one meta line in mono capitals (time · source) with the gold link on the right.
- Padding 12. The whole card is tappable; the gold link only names the destination.

## 8. Carousel
- Full width, paged: one card fills the row (16 screen margins); swipe to page.
- Page indicator below: short bars, active one wider and gold, others `border`.
- Sits directly on the screen background, never nested inside a card.

## 9. Tabs
- In-screen tabs are always a segmented control: one bordered box (6 corners, 2 inner padding), active segment filled with `lift`, text `bone`; inactive text `dim`.
- No underline tabs and no chip tabs. If a list needs filtering, use a segmented control or search.
- Bottom tab bar: outline icons; active icon and label gold.

## 10. Buttons
- Primary: outline (1px border + text, no fill), 6 corners, 15 semibold, 48 tall. Colour = context accent.
- Context accent: gold on MyBoon's own screens. Inside an integrated app's screens (Polymarket, Phoenix, Meteora...), the app's brand colour, so it feels like that app. App brand colours live in one map, not ad hoc.
- Secondary: hairline `border` outline, `bone` text. Tertiary: text link in the context accent.
- One primary per screen.

## 11. Swipe-to-confirm
- Used for every trade and send. Outline track (52 tall, 6 corners) in the context accent; solid square knob (44) with an arrow; label states the action and amount ("Swipe to buy · $50").
- Track fills faintly behind the knob as it moves; release before the end snaps back. Completion fires the confirm haptic.

## 12. Bottom sheet
- Grabber only, no close button. Background `ground`, 12 top corners, hairline top border; screen behind dims.
- Close by dragging down or tapping the dimmed area. Opens at content height.

## 13. Forms
- Money amounts: amount-first card (`ground`/card colour, 8 corners): mono label ("YOU SEND"), 34 mono bold number, token + gold MAX on the right, mono balance line under.
- Other fields: boxed (1px `border`, 6 corners, 12 padding, 15 text); mono capital label above; border turns gold (context accent) on focus.
- Errors: `vermillion` 12 text directly under the field. Never a popup for field errors.

## 14. Alerts and toasts
- Success: toast drops from the top (lift fill, 1px hairline, radius 6), outline status icon in viridian, gold "View" link on the right, auto-dismisses after 3s, swipe up to dismiss.
- Errors: inline banner on the screen where the problem is (hairline box, vermillion outline icon, gold fix link like "Add SOL →"). It stays until fixed.
- Never use coloured side stripes or left-border accents anywhere.

## 15. Notifications
- Boxed cards (§7), grouped by day under mono faint labels (TODAY, YESTERDAY).
- Unread: small 6px gold square before the title, an allowed exception to §1. Read: title in dim.
- Meta line: age · kind (2M · PRICE ALERT). No filter until volume needs it.

## 16. Signing (PARKED)
- On hold: external wallets (Phantom, Solflare via Mobile Wallet Adapter) show their own signing UI, so our pre-sign summary vs the embedded wallet flow needs its own pass.

## 17. Loading and empty states
- Lists load with skeleton cards: boxed cards (§7) with lift-colour bars shaped like title, text and meta. No full-screen spinners.
- Spinner only inside a button while its action runs.
- Empty state: centred faint outline icon (32, §5), 18 title, one 14 dim line, one outline primary button.
