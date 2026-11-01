# 2026-11-01 ETF trial — TRIAL, NOT FOR PUBLISHING

Source (reported): Wu Blockchain on X, https://x.com/WuBlockchain/status/2116405078081102298
Facts: US spot BTC ETFs net outflows $643M on Oct 30; BlackRock IBIT $234M; spot ETH ETFs $156M, 5th straight day of net outflows.
Host: Hank (orion 1.1x). No video generation. No sign-off (on hold). No BREAKING bar.
**Ticker: MOCK DATA** (copied from `_example/ticker.json`, fake numbers, never air).

| # | Story | Line | Type | Visual | Asset | Voice | Status |
|---|---|---|---|---|---|---|---|
| 1 | Intro | (locked) | LOCKED | wide center | locked/bookends/intro_v1.mp4 | in take | done |
| 2 | ETF | "Investors pulled six hundred forty-three million dollars from Bitcoin ETFs on Friday." | OVER VISUAL | chart, push-in; gold box on Daily Total Net Inflow -$643.33M; lower third "BITCOIN ETFs SEE $643M IN OUTFLOWS" | visuals/chart_crop.png | voice/line_2.mp3 (4.26 s) | done |
| 3 | ETF | "BlackRock's IBIT alone saw two hundred thirty-four million in outflows, according to Wu Blockchain." | OVER VISUAL | post, focus IBIT sentence; gold box on $234 million | visuals/post_body.png | voice/line_3.mp3 (5.90 s) | done |
| 4 | ETF | "Ether funds had one hundred fifty-six million in outflows. That's their fifth straight day." | OVER VISUAL | same post, focus/box on Ethereum sentence (no Ether chart, post reused) | visuals/post_body.png | voice/line_4.mp3 (4.62 s) | done |
| 5 | End card | (locked) | LOCKED | wordmark | locked/bookends/endcard_v1.mp4 | silent | done |

## Asset notes
- `chart_crop.png`: crop (0,0)-(930,765) of chart.png. Removes the SoSoValue watermarks (plot centre and scrubber), the empty black bottom area and the cut-off BTC price pill. Shows Apr–Jun bars only; the Oct 30 bar is outside the crop (it sits right of the watermark).
- `post_body.png`: crop (20,330)-(1175,566) of post.png = body lines 2-7. Removes "According to SoSoValue data", the embedded SoSoValue chart and the headline wording "Ethereum ETFs Lose". Side effect: the Wu Blockchain header/handle is not on screen; attribution is in the voice only.
- Voice: TTS raw → edge silence trimmed → loudnorm I=-14, TP=-1.5. line_4: mid-line pause cut from 0.42 s to 0.31 s (QC gap rule).
- Render: Remotion `EtfTrial` (src/episodes/EtfTrial.tsx), then whole-file +1.8 dB (video stream copied) so integrated loudness incl. silent end card hits -14 LUFS.

## QC (v1)
Duration 23.89 s, 1080p30. Integrated -14.1 LUFS, true peak -2.6 dBTP. Transcript matches script word for word. No silence > 0.4 s inside a line (gaps only at intro→row 2 cut and end card). No black frames; only freeze = end card hold. No clicks at cuts. No SoSoValue visible. Facts match source.

## v2 (Nov 1, 2026): always-on overlays rule
- Logo bug + mock ticker on from frame 0 (logo fades in once, 0–0.5 s) through intro and all rows, one layer via `EpisodeShell`; hard cut to a clean end card.
- Lower third "HANK WALSH / Lead Anchor" over the intro, 1.0–4.0 s.
- Intro trimmed 5.07 → 4.77 s (143 f): gap from last intro word to row 2 is 0.28 s (was 0.58 s).
- QC v2: 23.59 s; -14.1 LUFS, true peak -2.7 dBTP; transcript word for word; no silence > 0.35 s inside the body; no clicks at cuts; no black frames; only freeze = end card hold.
