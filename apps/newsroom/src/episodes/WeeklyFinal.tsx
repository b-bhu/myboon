import { Audio, OffthreadVideo, Sequence, staticFile } from "remotion";
import { OverVisual, HOLD_TAIL } from "../components/OverVisual";
import { EpisodeShell, END_CARD_FRAMES } from "../components/EpisodeShell";
import { BODY_FRAMES, CHART_LOWER_THIRDS, INTRO_FRAMES, ONCAM, SHOTS, VO } from "./weeklyFinalTimeline";

/**
 * Episode 2026-11-08-weekly — "The week that was, the week ahead". FINAL cut.
 * Locked weekly intro → OV rows + ON CAM bridges (wk_02–wk_05) → locked end card.
 * Timing comes from the real VO (voice/line_XX.wav, Hank orion 1.1x) and whisper word times;
 * see weeklyFinalTimeline.ts (generated) and episodes/2026-11-08-weekly/qc/build_timeline.py.
 */
const FPS = 30;
export const WEEKLY_FINAL_FRAMES = BODY_FRAMES + END_CARD_FRAMES;

// Per-take gain to sit near -14 LUFS (measured integrated loudness of each take's in-take voice).
const ONCAM_VOLUME: Record<string, number> = {
  "wk_02_election.mp4": 0.77,
  "wk_03_india.mp4": 1,
  "wk_04_weekahead.mp4": 1,
  "wk_05_close.mp4": 0.83,
};
const full = { width: "100%", height: "100%" } as const;

export const WeeklyFinal: React.FC = () => (
  <EpisodeShell
    bodyFrames={BODY_FRAMES}
    tickerSlug="2026-11-08-weekly"
    dateLabel="MON 9 NOV"
    lowerThirds={[
      { from: 30, durationInFrames: 90, name: "HANK WALSH", role: "Lead Anchor" },
      ...CHART_LOWER_THIRDS.map((c) => ({ from: c.from, durationInFrames: c.frames, headline: c.headline })),
    ]}
  >
    <Sequence durationInFrames={INTRO_FRAMES}>
      <OffthreadVideo src={staticFile("locked/bookends/weekly_intro_v1.mp4")} style={full} volume={0.85} />
    </Sequence>
    {ONCAM.map((o) => (
      <Sequence key={o.src} from={o.from} durationInFrames={o.frames}>
        <OffthreadVideo src={staticFile(o.src)} startFrom={o.trimStart} style={full} volume={ONCAM_VOLUME[o.src.split("/").pop() as string] ?? 1} />
      </Sequence>
    ))}
    {SHOTS.map((s) => (
      <Sequence key={`${s.from}`} from={s.from} durationInFrames={s.frames}>
        <OverVisual
          src={staticFile(s.src)}
          assetWidth={s.w}
          assetHeight={s.h}
          mode={s.mode}
          lineSeconds={s.frames / FPS - HOLD_TAIL}
          focus={s.focus}
        />
      </Sequence>
    ))}
    {VO.map((v) => (
      <Sequence key={v.src} from={v.from} durationInFrames={v.frames}>
        <Audio src={staticFile(v.src)} />
      </Sequence>
    ))}
  </EpisodeShell>
);
