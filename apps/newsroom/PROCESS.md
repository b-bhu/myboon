# MyBoon News — Production Process

This file is the source of truth for how every MyBoon News video is made.
If a step is not here, we don't do it. If we change how we work, we change this file first.

## Principles
1. Only two things are generated per episode: **voice** (Grok TTS API) and **the characters' ON CAM shots** (currently Hank; Grok Imagine). Everything else is locked kit or real assets assembled in Remotion.
2. Every line in an episode is one of three row types. The type decides the work.
3. Nothing is made that is not on the approved episode sheet.
4. Each step ends with Bibhu's OK before the next starts. No skipping, no bundling.
5. Timing comes from the news, not from fixed numbers.

## Row types
| Type | What it is | Who makes it |
|---|---|---|
| LOCKED | Reused kit: intro, sign-off, end card, overlays, set | Made once, never regenerated |
| ON CAM | A character (currently Hank) seen speaking. Used to introduce a story or say why it matters | Generated, one take |
| OVER VISUAL | A real X post, chart or page, the character's voice over it | Built in Remotion, no generation |

## Steps: brief to upload
1. **Brief in.** Content Producer sends stories and facts. Bibhu picks stories and owns claim checks.
2. **Rundown.** Stories ordered by importance. One host per story, no handoffs inside a story.
3. **Episode sheet.** Script and visuals written together in `episodes/<date-slug>/sheet.md`. Every line gets a row type, camera mark or visual, and its asset. Bibhu approves the sheet.
4. **Assets locked for the episode.** All screenshots/charts in `visuals/`, `ticker.json` filled. Nothing generated before this.
5. **Voice.** Every line voiced with `scripts/voice.ts` in the locked voice. Bibhu listens and approves. The voice track is the timeline.
6. **ON CAM shots.** Generate only ON CAM rows, from the character's locked master frame (currently Hank), starting at the camera mark where the previous ON CAM ended. One take each; max 2 retakes after a failed check. Frame check: seated, one desk, screen dark, no warping, no generated text.
7. **Edit (Remotion).** Locked intro → rows in sheet order → sign-off → end card. Hard cuts only. Overlays: logo, lower third, price ticker, BREAKING bar when needed.
8. **QC.** Frames every 0.5 s and at every cut; transcript vs sheet word for word; gaps >0.4 s; loudness −14 LUFS, peak ≤ −1 dBTP; every number on screen matches approved facts; final cut checked row by row against the sheet.
9. **Delivery.** Cut + short QC report to Bibhu. Bibhu uploads. We never post.

## Episode sheet template
| # | Story | Line | Type | Camera mark / visual | Asset | Status |
|---|---|---|---|---|---|---|
| 0 | Intro | (locked) | LOCKED | wide center | locked/bookends/intro | done |
| 1a | | | ON CAM | center → 20° left | generate | |
| 1b | | | OVER VISUAL | push on … | visuals/… | |
| … | Sign-off | "This is MyBoon News." | LOCKED | | locked/bookends/signoff | done |

## Camera marks (one character, centered; currently Hank)
Fixed marks: **center**, **20° left**, **20° right**. Each ON CAM shot is one slow arc between marks and starts where the previous ON CAM ended.

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
| Intro (Hank solo, wide center) | locked (approved Nov 1, 2026) | locked/bookends |
| Sign-off | on hold: lip sync doesn't match (Bibhu, Nov 1) | locked/bookends |
| End card | locked (approved Nov 1, 2026) | locked/bookends |
| Overlays: logo, lower third, BREAKING bar | locked (approved Nov 1, 2026) | src/chrome |
| Price ticker (BTC, ETH, SOL… daily %) | locked (approved Nov 1, 2026) | src/chrome, data per episode |
| Screenshot push-in style (OVER VISUAL) | awaiting approval | src/components/OverVisual.tsx |
| Cut rules | awaiting approval | "Cut rules" below |
| QC checklist | done | step 8 |

## Screenshot push-in style (awaiting approval)
- Real asset only, on the set backdrop (walletCore #031F2C). No blur, gradient, shadow or glow: 1 px borderMuted edge, 4 px radius.
- Fitted inside the OVER VISUAL safe area x160 y160 1600x720 (clears logo bug and the lower-third/ticker slot). `post`: centred, 92% of safe height. `chart`: full safe width.
- One push-in 1.00 → 1.06, ease-out cubic, lands 0.5 s before the end and holds. Shot = voice line + 0.3 s. Optional focus point (0-1) for gentle drift. No pans, rotation or whoosh.
- Optional highlight: plain #FFD166 3 px rectangle, wipes on in 0.3 s at a set time. Off by default. No arrows, circles or emoji.
- Logo and ticker stay on top.

## Cut rules (awaiting approval)
- Hard cuts only. No transitions, dissolves or whooshes.
- Cut on line boundaries.
- OVER VISUAL holds for the voice line plus about 0.3 s.
- Never cut mid-move: moves must land.
- No frozen frame longer than a hold.
- The camera never jumps between ON CAM shots: follow the camera marks.

## Open issues
- Lip sync on TTS-over-mute takes needs a method: sign-off mouth movement does not match the Orion voice (Bibhu, Nov 1). Test a lip-sync method before any more ON CAM takes are locked.

## Banned
Code-built number cards, PSA filler, on-screen source lines, AI tags, date/time stamps, whoosh SFX, hosts standing or off the desk, camera moves that never land, invented or restyled sets/characters/graphics.
