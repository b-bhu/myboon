import { AbsoluteFill, OffthreadVideo, Sequence, staticFile } from "remotion";
import { Overlays, type BreakingCue, type LowerThirdCue } from "../chrome/Overlays";

/** LOCKED overlays rule (Nov 1, 2026): ONE Overlays layer (logo bug + price ticker) from frame 0
 *  through every row (intro, ON CAM, OVER VISUAL) until the hard cut to the end card, which stays clean.
 *  Rows never mount their own overlays. Lower thirds / BREAKING cue in episode frames (frame 0 = intro start). */
export const END_CARD_FRAMES = 92; // endcard_v1.mp4 = 3.05 s

export const EpisodeShell: React.FC<{
  bodyFrames: number; // intro + all rows
  tickerSlug: string;
  lowerThirds?: LowerThirdCue[];
  breaking?: BreakingCue[];
  children: React.ReactNode; // intro + rows, sequenced in body frames
}> = ({ bodyFrames, tickerSlug, lowerThirds, breaking, children }) => (
  <AbsoluteFill style={{ backgroundColor: "#031F2C" }}>
    <Sequence durationInFrames={bodyFrames}>
      {children}
      <Overlays tickerSlug={tickerSlug} lowerThirds={lowerThirds} breaking={breaking} />
    </Sequence>
    <Sequence from={bodyFrames} durationInFrames={END_CARD_FRAMES}>
      <OffthreadVideo src={staticFile("locked/bookends/endcard_v1.mp4")} />
    </Sequence>
  </AbsoluteFill>
);
