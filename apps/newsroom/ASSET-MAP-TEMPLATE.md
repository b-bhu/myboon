# Asset map template — MyBoon News

Copy this file into each episode folder as `ASSET-MAP.md` (or fill a sheet tab with the same columns). Complete it **before the first Remotion stitch**. Content Producer reviews; News Producer fixes.

## How to use
1. **News Producer** fills one row per spoken OVER VISUAL beat from the approved episode sheet (and mid-line cut segments as separate rows when one VO line names two screens).
2. **Spoken beat (must show)** lists every name, ticker, price, or % the VO says that must be visible on the still. If the line says three prints, list all three.
3. **Asset file** is the real file under `visuals/` (or locked bookend path). Type is `chart`, `post`, or `page`.
4. **Match?** — News Producer self-checks first (`yes` / `no` / `rewrite line`).
5. **Content Producer** reviews the map (not the whole cut): confirms Match?, adds Notes, returns OK or fix list.
6. News Producer fixes assets or rewrites the spoken line until every row is `yes`. **No first stitch until CP feedback is OK.**
7. Keep the filled map next to `sheet.md` for QC (step 9): every spoken name/ticker/print must still appear on the still for that line.

Locked intro / end card / sign-off do not need proof rows unless Bibhu asks. ON CAM rows (when used) are out of scope for this map.

## Episode
- Slug:
- Date badge (`FRI D MMM` or off):
- Ticker source: Hyperliquid `metaAndAssetCtxs`
- Ticker asOf:
- Symbols:
- CP review: pending / OK (date)
- NP fixes applied:

## Map
| Line # | Spoken beat (must show) | Asset file | Type (chart/post/page) | Match? | Notes |
|---|---|---|---|---|---|
| 02 | | visuals/… | | | |
| 03 | | visuals/… | | | |
| 04 | | visuals/… | | | |
| 07a | e.g. SOXL (mid-line first half) | visuals/… | chart | | hard cut at boundary |
| 07b | e.g. KORU (mid-line second half) | visuals/… | chart | | |
| … | | | | | |

## Rules (do not skip)
- Every spoken name / ticker / print appears on the still for that line — **or rewrite the line**.
- Do not reuse a board/chart that shows the wrong market or names under a different spoken beat.
- Mid-line picture cuts: one row per screen; cut when the VO names the second screen.
- Mock / EXAMPLE ticker data is never "Match? yes" for air — see PROCESS ticker gate.
- CP owns verified facts; NP does not re-verify numbers here — only picture match to the spoken beat.
