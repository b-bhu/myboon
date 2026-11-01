# @myboon/newsroom — MyBoon News

Remotion home for the MyBoon News bulletin. Everything that isn't generated lives here; generation (host takes, voice) is driven from `scripts/`.

## Layout
- `locked/` — made once, approved, reused: `studio/`, `hosts/`, `bookends/`, `chrome/`, `fonts/`, `voices/`
- `episodes/` — one folder per episode (see `episodes/README.md`)
- `src/` — Remotion compositions (`NewsroomEpisode`, 1920x1080 @ 30fps)
- `scripts/voice.ts` — `generateVoice({ host, text, out })`: Hank = orion @1.1x, Marcus = altair @1.1x

## Episode sheet row types
| Type | Meaning | Work |
|---|---|---|
| **LOCKED** | Reused kit: intro, sign-off, end card, overlays, ticker design | Never generated again |
| **ON CAM** | Host seen on camera | The only thing generated. Start angle = previous ON CAM end angle |
| **OVER VISUAL** | Line plays over a real post/chart/page | Built in the edit, no generation |

Sheet is approved before anything is made; final cut is checked against it row by row.

## Commands
```
pnpm --filter @myboon/newsroom dev      # studio
pnpm --filter @myboon/newsroom still    # out/still.png
source /home/box/secrets/xai.env && pnpm --filter @myboon/newsroom voice --host hank --text "..." --out /tmp/x.mp3
```

## Overlays (src/chrome)
`<Overlays tickerSlug lowerThirds breaking />` composes the logo bug, lower third, BREAKING bar and price ticker. Layout numbers live in `src/chrome/layout.ts`: ticker strip 60 px at the bottom, crawl 120 px/s right to left (seamless loop, 380 px per item); lower third and BREAKING bar share one slot 24 px above the ticker (never cue both at once); 64 px side margin; wipes ~0.3 s.
Preview: `npx remotion render src/index.ts OverlaysPreview out/overlays_preview.mp4`.

## Ticker data
Schema in `src/ticker.ts`: `{ "items": [{ "symbol", "price", "changePct" }] }` at `episodes/<slug>/ticker.json` (served via `public/episodes` symlink). Bibhu supplies the numbers each episode.
**`episodes/_example/ticker.json` is FAKE EXAMPLE DATA for layout only. Never air it, never invent real numbers.**
