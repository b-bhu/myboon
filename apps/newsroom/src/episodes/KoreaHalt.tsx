import { Audio, OffthreadVideo, Sequence, staticFile } from "remotion";
import { OverVisual, overVisualFrames } from "../components/OverVisual";
import { EpisodeShell, END_CARD_FRAMES } from "../components/EpisodeShell";

// Episode 2026-11-06-korea-halt. OVER VISUAL only; ON CAM deferred. Sheet: episodes/2026-11-06-korea-halt/sheet.md
const E = "episodes/2026-11-06-korea-halt";
const FPS = 30;
const INTRO = 143; // same trim as EtfTrial
type Vis = { src: string; w: number; h: number; mode: "post" | "chart" };
const board: Vis = { src: `${E}/visuals/joongang-kospi-board.jpg`, w: 1200, h: 683, mode: "chart" };
const chips: Vis = { src: `${E}/visuals/samsung-hynix-board.jpg`, w: 1180, h: 1422, mode: "chart" };
const usOvernight: Vis = { src: `${E}/visuals/us-overnight-chips.png`, w: 1200, h: 680, mode: "chart" };
const halt: Vis = { src: `${E}/visuals/kobeissi-kospi-halt.jpg`, w: 814, h: 1199, mode: "post" };
const skhx: Vis = { src: `${E}/visuals/hl-skhx-oi.png`, w: 1920, h: 1113, mode: "chart" };
const soxl: Vis = { src: `${E}/visuals/hl-soxl-oi.png`, w: 1920, h: 1113, mode: "chart" };
const koru: Vis = { src: `${E}/visuals/hl-koru-oi.png`, w: 1920, h: 1113, mode: "chart" };
const kalshi: Vis = { src: `${E}/visuals/kalshi-ssp.jpg`, w: 1200, h: 675, mode: "chart" };

type Picture =
  | { kind: "single"; vis: Vis }
  | { kind: "split"; first: Vis; second: Vis; cutFrame: number };
type Row = { voice: string; line: number; picture: Picture };

const ROWS: Row[] = [
  { voice: "line_02.mp3", line: 11.416, picture: { kind: "single", vis: board } },
  { voice: "line_03.mp3", line: 7.628, picture: { kind: "single", vis: halt } },
  { voice: "line_04.mp3", line: 7.628, picture: { kind: "single", vis: chips } },
  { voice: "line_05.mp3", line: 9.091, picture: { kind: "single", vis: skhx } },
  { voice: "line_06.mp3", line: 13.74, picture: { kind: "single", vis: usOvernight } },
  { voice: "line_07.mp3", line: 11.99, picture: { kind: "split", first: soxl, second: koru, cutFrame: 165 } },
  { voice: "line_08.mp3", line: 7.941, picture: { kind: "single", vis: kalshi } },
  { voice: "line_09.mp3", line: 2.978, picture: { kind: "single", vis: kalshi } },
];
const rowFrames = ROWS.map((r) => overVisualFrames(r.line, FPS));
const BODY = INTRO + rowFrames.reduce((a, b) => a + b, 0);
export const KOREA_HALT_FRAMES = BODY + END_CARD_FRAMES;

export const KoreaHalt: React.FC = () => {
  let at = INTRO;
  return (
    <EpisodeShell bodyFrames={BODY} tickerSlug="2026-11-06-korea-halt" dateLabel="FRI 6 NOV" lowerThirds={[
      { from: 30, durationInFrames: 90, name: "HANK WALSH", role: "Lead Anchor" },
      { from: INTRO, durationInFrames: rowFrames[0], headline: "KOREA TRIGGERS MARKET HALT" },
    ]}>
      <Sequence durationInFrames={INTRO}><OffthreadVideo src={staticFile("locked/bookends/intro_v1.mp4")} /></Sequence>
      {ROWS.map((r, i) => {
        const from = at; at += rowFrames[i];
        return (
          <Sequence key={i} from={from} durationInFrames={rowFrames[i]}>
            {r.picture.kind === "single" ? (
              <OverVisual src={staticFile(r.picture.vis.src)} assetWidth={r.picture.vis.w} assetHeight={r.picture.vis.h}
                mode={r.picture.vis.mode} lineSeconds={r.line} focus={{ x: 0.5, y: 0.5 }} />
            ) : (
              <>
                <Sequence durationInFrames={r.picture.cutFrame}>
                  <OverVisual src={staticFile(r.picture.first.src)} assetWidth={r.picture.first.w} assetHeight={r.picture.first.h}
                    mode={r.picture.first.mode} lineSeconds={r.picture.cutFrame / FPS - 0.3} />
                </Sequence>
                <Sequence from={r.picture.cutFrame} durationInFrames={rowFrames[i] - r.picture.cutFrame}>
                  <OverVisual src={staticFile(r.picture.second.src)} assetWidth={r.picture.second.w} assetHeight={r.picture.second.h}
                    mode={r.picture.second.mode} lineSeconds={(rowFrames[i] - r.picture.cutFrame) / FPS - 0.3} />
                </Sequence>
              </>
            )}
            <Audio src={staticFile(`${E}/voice/${r.voice}`)} />
          </Sequence>
        );
      })}
    </EpisodeShell>
  );
};
