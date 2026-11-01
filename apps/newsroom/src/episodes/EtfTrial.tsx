import { AbsoluteFill, Audio, OffthreadVideo, Sequence, staticFile } from "remotion";
import { OverVisual, overVisualFrames } from "../components/OverVisual";
import { Overlays } from "../chrome/Overlays";

// TRIAL episode 2026-11-01-etf-trial (not for publishing). Sheet: episodes/2026-11-01-etf-trial/sheet.md
const E = "episodes/2026-11-01-etf-trial";
const FPS = 30;
const INTRO = 152; // intro_v1.mp4 = 5.067 s
const END = 92; // endcard_v1.mp4 = 3.05 s
const chart = { src: `${E}/visuals/chart_crop.png`, w: 930, h: 765 };
const post = { src: `${E}/visuals/post_body.png`, w: 1155, h: 236 };

type Row = { voice: string; line: number; vis: typeof chart; mode: "post" | "chart"; focus: { x: number; y: number };
  highlight?: { x: number; y: number; w: number; h: number; at: number } };
export const ROWS: Row[] = [
  { voice: "line_2.mp3", line: 4.258, vis: chart, mode: "chart", focus: { x: 0.2, y: 0.27 },
    highlight: { x: 0.006, y: 0.222, w: 0.575, h: 0.092, at: 1.2 } },
  { voice: "line_3.mp3", line: 5.904, vis: post, mode: "post", focus: { x: 0.7, y: 0.3 },
    highlight: { x: 0.71, y: 0.175, w: 0.195, h: 0.215, at: 1.5 } },
  { voice: "line_4.mp3", line: 4.624, vis: post, mode: "post", focus: { x: 0.4, y: 0.55 },
    highlight: { x: 0.004, y: 0.395, w: 0.988, h: 0.425, at: 0.6 } },
];
const rowFrames = ROWS.map((r) => overVisualFrames(r.line, FPS));
const newsFrames = rowFrames.reduce((a, b) => a + b, 0);
export const ETF_TRIAL_FRAMES = INTRO + newsFrames + END;

export const EtfTrial: React.FC = () => {
  let at = INTRO;
  return (
    <AbsoluteFill style={{ backgroundColor: "#031F2C" }}>
      <Sequence durationInFrames={INTRO}><OffthreadVideo src={staticFile("locked/bookends/intro_v1.mp4")} /></Sequence>
      {ROWS.map((r, i) => {
        const from = at; at += rowFrames[i];
        return (
          <Sequence key={i} from={from} durationInFrames={rowFrames[i]}>
            <OverVisual src={staticFile(r.vis.src)} assetWidth={r.vis.w} assetHeight={r.vis.h} mode={r.mode}
              lineSeconds={r.line} focus={r.focus} highlight={r.highlight} />
            <Audio src={staticFile(`${E}/voice/${r.voice}`)} />
          </Sequence>
        );
      })}
      <Sequence from={INTRO} durationInFrames={newsFrames}>
        <Overlays tickerSlug="2026-11-01-etf-trial"
          lowerThirds={[{ from: 0, durationInFrames: rowFrames[0], headline: "BITCOIN ETFs SEE $643M IN OUTFLOWS" }]} />
      </Sequence>
      <Sequence from={INTRO + newsFrames} durationInFrames={END}><OffthreadVideo src={staticFile("locked/bookends/endcard_v1.mp4")} /></Sequence>
    </AbsoluteFill>
  );
};
