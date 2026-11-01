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
