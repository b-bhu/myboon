# MyBoon News — Production Process

This file is the source of truth for how every MyBoon News video is made.
If a step is not here, we don't do it. If we change how we work, we change this file first.

## Principles
1. Only two things are generated per episode: **voice** (Grok TTS API) and **characters' ON CAM shots** (currently Hank; Grok Imagine). Everything else is locked kit or real assets assembled in Remotion.
2. Every line in an episode is one of three row types. The type decides the work.
3. Nothing is made that is not on the approved episode sheet.
4. Bibhu's OK is needed at exactly three points: the script (episode sheet, step 3), the rough cut (step 7) and the final (step 10). Every other step runs straight on to the next.
5. Timing comes from the news, not from fixed numbers.
6. **Default ship path is OVER VISUAL only.** Daily bulletins ship as locked intro → OV rows → end card until lip sync is solved. ON CAM is optional and last (or skipped).
7. **Content Producer supplies verified facts.** News Producer does not re-verify numbers — starts at script / the next production step. Bibhu still owns claim checks on the brief.
8. **Don't re-confirm locked kit.** State the next pipeline step and move.

## Show types
Every episode is one of these. The show type picks the intro; everything else in this file applies to both.

| Show | What it covers | Intro (locked) | Shape |
|---|---|---|---|
| **Daily update** | Today's news, 5–6 stories, about 2 min | `locked/bookends/intro_v1.mp4` (default intro, "Good morning…") | Intro → OV rows → end card; ON CAM optional |
| **Weekly update** | The week that was and the week ahead | `locked/bookends/weekly_intro_v1.mp4` ("Good evening. This is MyBoon News: the week that was, and the week ahead.") | Intro → first OV row (episode rundown) → recap stories → week-ahead calendar → Hank sign-off → end card; ON CAM bridges between sections |

A new show type is added here first, with its own locked intro.

## Intro camera move (locked Nov 9, 2026)
Every intro uses the same camera behaviour, whatever the format. The footage and the line can change; the move never does.
- Starts on the wide center master (`locked/hosts/hank_master_center_wide_v1.jpg`): the full set, character (currently Hank) seated small at center.
- One slow, continuous push-in straight toward the character, no arc or pan. It lands at a medium shot (desk edge to just above the head) near the end of the line and holds.
- Each show type has its own intro (see Show types). A new show type gets a new intro made once with this same move, then locked and reused. The intro carries only a reusable line; episode-specific lines (rundown, "looking back…") go to the first OVER VISUAL row.

## Row types
| Type | What it is | Who makes it |
|---|---|---|
| LOCKED | Reused kit: intro, sign-off, end card, overlays, set | Made once, never regenerated |
| ON CAM | A character (currently Hank) seen speaking. Used to introduce a story or say why it matters | Generated, one take — optional; last when used |
| OVER VISUAL | A real X post, chart or page, the character's voice over it | Built in Remotion, no generation |

## Steps: brief to delivery
Bibhu's OK at three gates only: **Gate 1 (script)** at step 3, **Gate 2 (rough cut)** at step 7, and **Gate 3 (final)** at step 10.
1. **Brief in.** Content Producer sends stories and verified facts. Bibhu picks stories and owns claim checks. News Producer does **not** re-verify the numbers.
2. **Rundown.** Stories ordered by importance. One host per story, no handoffs inside a story. Default: OV-only path unless Bibhu asks for ON CAM bridges.
3. **Episode sheet.** Script and visuals written together in `episodes/<date-slug>/sheet.md`. Every line gets a row type, camera mark or visual, and its asset. Sheet also lists **ticker symbols** and the expected **asOf** window. **Gate 1 (script):** Bibhu approves the sheet.
4. **Assets locked for the episode.** All screenshots/charts in `visuals/`. **Real** `ticker.json` filled (see Ticker gate). Nothing generated before this. Date badge label set if used (`FRI D MMM`).
5. **Visual–script lock.** Fill `ASSET-MAP.md` from the template (one row per spoken beat). Content Producer reviews the map; News Producer fixes mismatches. Every spoken name / ticker / print must appear on the still for that line — **or rewrite the line**. No first stitch until CP feedback is OK.
6. **Voice.** Every line voiced with `scripts/voice.ts` in the locked voice. The voice track is the timeline and goes straight to step 7.
7. **Edit OV cut (Remotion).** Locked intro → OVER VISUAL rows in sheet order → end card. Hard cuts only. Mid-line picture cuts allowed when one VO line names two screens (e.g. SOXL then KORU): hard cut at the named boundary; each fund matches its screen. Overlays: logo bug, price ticker, and optional date badge on from frame 0 and continuous until the hard cut to the end card (one layer via `EpisodeShell`, never per row); anchor lower third (name/role) over the intro ~1.0–4.0 s; other lower thirds and BREAKING bar only where the sheet says. **Gate 2 (rough cut):** stop for Bibhu's OK on the OV cut before step 8 or 9.
8. **ON CAM shots (optional / last).** Only when Bibhu asks. Generate only ON CAM rows, from the character's locked master frame (currently Hank), starting at the camera mark where the previous ON CAM ended. One take each; max 2 retakes after a failed check. Frame check: seated, one desk, screen dark, no warping, no generated text. Skip entirely while lip sync is open unless Bibhu overrides.
9. **QC.** Frames every 0.5 s and at every cut; transcript vs sheet word for word; gaps >0.4 s; loudness −14 LUFS, peak ≤ −1 dBTP; every number on screen matches approved facts; every spoken name/ticker/print appears on the still for that line; ticker is real (not EXAMPLE); date badge correct if used; final cut checked row by row against the sheet and asset map.
10. **Delivery.** Cut + short QC report to Bibhu. Prefer a light encode + Desktop / Library copy when chat attachments fail. **Gate 3 (final):** Bibhu OKs the final cut and QC report before delivery is called done. Bibhu uploads. **We never post.**

## Episode sheet template
| # | Story | Line | Type | Camera mark / visual | Asset | Status |
|---|---|---|---|---|---|---|
| 0 | Intro | (locked, per show type) | LOCKED | wide center → push-in | daily: locked/bookends/intro_v1.mp4 · weekly: locked/bookends/weekly_intro_v1.mp4 | done |
| 1a | | | OVER VISUAL | push on … | visuals/… | |
| 1b | | | OVER VISUAL (mid-line cut OK) | still A → still B at boundary | visuals/… | |
| … | Sign-off | "This is MyBoon News." | LOCKED | | locked/bookends/signoff | on hold |
| … | End card | (locked) | LOCKED | | locked/bookends/endcard | done |

Sheet footer (required):
- **Ticker symbols:** e.g. BTC, ETH, SOL, XRP, DOGE, BNB
- **Ticker source:** Hyperliquid `metaAndAssetCtxs` (Content Producer pull)
- **asOf:** ISO timestamp from CP
- **Date badge:** `FRI D MMM` or off

## Camera marks (one character, centered; currently Hank)
Fixed marks: **center**, **20° left**, **20° right**. Each ON CAM shot is one slow arc between marks and starts where the previous ON CAM ended. Used only when ON CAM is in the rundown.

## Locked items
| Item | Status | Location |
|---|---|---|
| One-chair newsroom set | locked (approved Nov 1, 2026) | locked/studio |
| Hank master frame (centered) | locked (approved Nov 1, 2026) | locked/hosts |
| Look line | done | locked/hosts |
| Colours, fonts, logo (from app tokens) | locked (approved Nov 1, 2026) | locked/chrome, locked/fonts |
| Camera marks | defined above | — |
| Hank voice: orion 1.1x | done | locked/voices |
| Marcus voice: altair 1.1x (on hold) | done | locked/voices |
| Intro (Hank solo, wide center → push-in to medium; see Intro camera move) | locked (approved Nov 1, 2026) | locked/bookends |
| Weekly intro (format intro) | locked (approved Nov 9, 2026) | locked/bookends/weekly_intro_v1.mp4 |
| Sign-off | on hold: lip sync doesn't match (Bibhu, Nov 1) | locked/bookends |
| End card | locked (approved Nov 1, 2026) | locked/bookends |
| Overlays: logo, lower third, BREAKING bar | locked (approved Nov 1, 2026); always-on rule below | src/chrome, src/components/EpisodeShell.tsx |
| Price ticker (BTC, ETH, SOL… daily %) | locked (approved Nov 1, 2026); Hyperliquid source locked Nov 6 | src/chrome, data per episode |
| Date badge (`FRI D MMM`, top-right, optional) | locked optional chrome (approved Nov 6, 2026; Korea halt) | src/chrome/DateBadge.tsx via Overlays |
| Screenshot push-in style (OVER VISUAL) | locked (approved Nov 1, 2026) | src/components/OverVisual.tsx |
| Cut rules | locked (approved Nov 1, 2026); mid-line OV cuts allowed Nov 6 | "Cut rules" below |
| Visual–script lock / asset map | locked (Nov 6, 2026) | ASSET-MAP-TEMPLATE.md per episode |
| QC checklist | done | step 9 |
| Default ship path: OV-only | locked (Nov 6, 2026) | Principles + Steps |

## Overlays rule (locked Nov 1, 2026; date badge Nov 6)
- Like a live news channel: logo bug and price ticker are on screen from the first frame of the episode, over the intro, every ON CAM shot and every OVER VISUAL, continuously, until the hard cut to the end card. The end card is clean.
- Optional **date badge** (episode date as `FRI D MMM`, e.g. `FRI 6 NOV`) sits top-right on the same body chrome, same fade-in as the logo bug, off on the end card. Implemented in `src/chrome/DateBadge.tsx`, mounted from `Overlays` when `dateLabel` is set.
- One overlays layer for the whole episode body (`src/components/EpisodeShell.tsx`). Rows never mount their own overlays; overlays never fade out or re-enter between rows. The logo's (and date badge's) one-time fade-in happens at frame 0 only.
- The anchor is named on first appearance: lower third with name/role (currently "HANK WALSH / Lead Anchor") over the intro, ~1.0–4.0 s.
- Other lower thirds and the BREAKING bar appear only where the sheet says, never both at once.

## Screenshot push-in style (locked Nov 1, 2026)
- Real asset only, on the set backdrop (walletCore #031F2C). No blur, gradient, shadow or glow: 1 px borderMuted edge, 4 px radius.
- Fitted inside the OVER VISUAL safe area x160 y160 1600x720 (clears logo bug and the lower-third/ticker slot). `post`: centred, 92% of safe height. `chart`: full safe width.
- One push-in 1.00 → 1.06, ease-out cubic, lands 0.5 s before the end and holds. Shot = voice line + 0.3 s. Optional focus point (0-1) for gentle drift. No pans, rotation or whoosh.
- Optional highlight: plain #FFD166 3 px rectangle, wipes on in 0.3 s at a set time. Off by default. No arrows, circles or emoji.
- Logo, date badge (if on), and ticker stay on top.

## Cut rules (locked Nov 1, 2026; mid-line OV Nov 6)
- Hard cuts only. No transitions, dissolves or whooshes.
- Cut on line boundaries by default.
- **Mid-line picture cuts allowed** when one VO line names two screens (e.g. SOXL then KORU): hard cut at the spoken boundary so each name matches its still; do not re-voice.
- OVER VISUAL holds for the voice line plus about 0.3 s (or the segment of a mid-line cut plus ~0.3 s).
- Never cut mid-move: moves must land.
- No frozen frame longer than a hold.
- The camera never jumps between ON CAM shots: follow the camera marks.

## Ticker gate (locked Nov 6, 2026)
- Named source: **Hyperliquid** `metaAndAssetCtxs` (mark + 24h % vs prevDayPx).
- Content Producer pulls marks and asOf; News Producer drops them into `episodes/<slug>/ticker.json` (and the public symlink path).
- Sheet lists symbols + asOf before Assets lock.
- **No final / no render-as-air** if `ticker.json` still carries an EXAMPLE / mock `_note` or placeholder prices. Mock data may be used only for layout tests, never as the air cut.

## Visual–script lock (locked Nov 6, 2026)
- Before the first stitch, every OV line has a row in the episode asset map (see `ASSET-MAP-TEMPLATE.md`).
- Content Producer reviews Match? / Notes; News Producer fixes assets or rewrites the line.
- Rule: if the line says three prints, the still must show all three — or the line changes.
- CP feedback OK is the gate into Voice / Edit OV.

## Open issues
- Lip sync on TTS-over-mute takes needs a method: sign-off mouth movement does not match the Orion voice (Bibhu, Nov 1). Test a lip-sync method before any more ON CAM takes are locked. Until then, default daily ship is OV-only; ON CAM optional / last or skip.

## Banned
Code-built number cards, PSA filler, on-screen source lines, AI tags, **clocks / "LIVE NOW" / "as of HH:MM" stamps**, whoosh SFX, hosts standing or off the desk, camera moves that never land, invented or restyled sets/characters/graphics, shipping with EXAMPLE/mock ticker data.

**Not banned:** the episode **date badge** (`FRI D MMM` top-right) — that is locked optional chrome.
