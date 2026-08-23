# Predict / Polymarket mockups — conventions from the Aug 2026 review pass

Scope: `docs/mockups/polymarket-{discover,updown-card,sports-detail,binary-detail,event-detail,profile}.html`
plus shared `polymarket-detail-system.css`. These conventions came out of a
three-persona design/product/CTO review followed by an applied fix pass across all
six mocks, plus an engineering-manager gap review of the app codebase. They are the
rules any React Native implementation must carry over. Scope decisions live in
`docs/modules/polymarket/PRDs/2026_08_23_polymarket_predict_redesign_PRD.md`; this
file is only presentation rules.

## Type and touch

- Nothing below a 9px floor (mock px ≈ pt at our phone widths; ~100 fixes applied).
- Primary tap targets ≥ 44px. Fixed during the pass: Chart/Book switch 27→34,
  book tabs 30→36, quick amounts 34→38, mini book rows 25→30. Do not regress these
  when porting to RN — use the post-fix mock values as minimums.
- Prices and odds render in tabular numerals (`font-variant-numeric: tabular-nums`
  in mocks; use `fontVariantNumeric` or a mono font in RN) so ticking values don't
  jitter.

## Colour and hierarchy

- Only the existing MyBoon palette tokens: `--wallet #031F2C`, `--ground #063343`,
  `--surface #083D50`, bone/border/accent per token file. No new hues.
- The darkest token `--wallet` is reserved for money surfaces (Profile capital card,
  Discover featured money card). Content cards stay on `--surface`. This contrast is
  intentional hierarchy, not inconsistency.
- Positive/negative semantics follow the existing app (teal/red family), never
  invented per-screen.

## Interaction

- Mobile-native behaviour only: `:active` press states, bottom sheets with grabbers,
  no hover anywhere, respect reduced-motion.
- Charts and order book share one switchable surface per screen — one segmented
  control, never stacked sections.
- Sheets keep the existing numpad interaction (`InlineNumpad.tsx` pattern);
  `inputmode="numeric"` equivalents on web.

## Language canon (copy-frozen)

Your pick · If you're right · Maximum loss · Deposit · Withdraw · Ready to collect ·
Higher/Lower · pUSD (never USDC in UI copy) · "Round closed" while settling (never an
instant result flash). One word per concept across every screen.

## Honesty rules

- Render nothing the API does not return: no scores, clocks, pick counts, badges.
- Settlement always passes through an explicit settling state before won/lost.
- Volume/traded metrics only where the API provides them.
