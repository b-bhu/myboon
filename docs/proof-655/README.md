# Proof — per-token Spot entry from wallet holdings (#655)

Design proof for task `t_8c33d598`. Open `spot-holdings.html` directly in a
browser (self-contained, no build): two 390×844 phone frames, one showing the
Home wallet section at rest and one showing the Spot holdings sheet. The control
bars above each frame toggle the sheet, the tap-target overlay, and a 9-token
state; they are test chrome, not part of the design.

## Screenshots

| File | State |
| --- | --- |
| `shot-1-home-resting.png` | Home wallet section at rest: Spot row 356×67, 3 chips + `+3`, chevron |
| `shot-2-spot-sheet.png` | Spot holdings sheet, 6 tokens, one Trade target per eligible row |
| `shot-3-many-tokens-targets.png` | 9 tokens, chips `+6`, tap-target overlay on sheet rows and Trade buttons |

## Measured geometry (`measure.json`)

Captured from the live page via `window.__measure()`, not estimated:

- account rows 356×67 (Spot row and protocol rows alike)
- decorative chip 20px, three chips maximum plus one `+N` chip
- per-token Trade target **56×44** (44pt minimum), 5 in the 6-token state,
  8 in the 9-token state (the ineligible row has no target)
- sheet rows **60px**, all equal; sheet header `9 tokens · $1,284.31`

## What this settles

See PRD decisions #19–#23 in
`docs/modules/wallet/PRDs/2026_07_21_beta_readiness_wallet_PRD.md` and
TC-NAV-004/006/007, TC-ROWS-003/008 in
`docs/modules/wallet/test cases/2026_07_21_beta_readiness_wallet_test_cases.md`.
Short version: the Spot row opens this sheet, chips stay decorative, each
eligible token row carries one Trade target to `/spot` with
`params: { token: MINT }`, and the sheet footer holds the venue-level link.

Not verified here: native rendering, real sheet insets, and a device tap test.
This is a browser proof of geometry and hierarchy, not a build.
