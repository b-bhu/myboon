# Final Eternal submission videos

These compositions produced the final Colosseum Eternal product demo and founder
pitch. Reusable Remotion code, corrected caption data, and selected stills are
kept in the repository. Large talking-head files, screen recordings, extracted
audio, Whisper binaries, caches, and rendered MP4s are local working assets and
must not be committed.

## Final deliverables

The checksum-verified final exports are stored outside the repository:

- `/Users/bibhu/Downloads/eternal_final_week_demo.mp4`
- `/Users/bibhu/Downloads/eternal_final_week_pitch.mp4`

The original talking-head recordings are also retained in Downloads:

- `/Users/bibhu/Downloads/final_eternal.mov`
- `/Users/bibhu/Downloads/pitch deck.mov`

## Compositions

- `FinalEternalDemo` — 1920×1080 product demo with talking head, product
  recordings, and word-level captions
- `FinalEternalPitch` — 1920×1080 founder pitch with normalized audio and
  word-level captions
- `FinalSubmissionScreens` — the screen-only visual plan used before final
  timing was locked

## Locked visual journey

1. Home feed, market venues, and connected wallet
2. Feed as a personal market analyst
3. Market calendar: what happened and what is coming
4. Bitcoin story: latest development and chronological timeline
5. Take Action handoff into Phoenix BTC-PERP
6. Research/event markers on the live chart
7. Order controls and positions
8. Integrated Solana venue grid
9. Wallet overview and successful swap flow
10. Product close on the feed

## Source selections

- `overview-feed-wallet.mp4`: 00:05.4–00:22.5
- `story-calendar.mp4`: 00:58.3–01:02.5
- `bitcoin-phoenix.mp4`: 00:17.0–00:27.8 and 00:30.6–00:49.0
- `action-center.mp4`: 00:08.0–00:15.0, 00:46.5–00:52.0, 00:53.5–01:02.5, and a success freeze at 01:14

The August 15 recording was reviewed but intentionally excluded because it shows
an older product UI. Source trimming remains non-destructive inside Remotion.

## Local asset staging

To rerender, restore local media under `public/final-submission/` using the paths
referenced by `FinalDemo.tsx`, `FinalPitch.tsx`, and `FinalSubmission.tsx`.
Talking-head files can be copied from Downloads. The selected product recordings
remain local under `public/final-submission/recordings/` and are ignored by Git.

Run:

```bash
pnpm final-submission:dev
pnpm final-submission:render
pnpm final-submission:pitch
```

The pitch audio track was loudness-normalized before rendering. If it is
regenerated, preserve timing and target approximately -16 LUFS with a true peak
at or below -1.5 dBTP.
