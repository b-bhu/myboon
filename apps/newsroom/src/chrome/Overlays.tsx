import { AbsoluteFill, Sequence } from "remotion";
import { loadBrandFonts } from "../brand";
import { LogoBug } from "./LogoBug";
import { LowerThird } from "./LowerThird";
import { BreakingBar } from "./BreakingBar";
import { PriceTicker } from "./PriceTicker";

loadBrandFonts();

export type LowerThirdCue = { from: number; durationInFrames: number; name?: string; role?: string; headline?: string };
export type BreakingCue = { from: number; durationInFrames?: number; headline: string };
export type OverlaysProps = { tickerSlug?: string; lowerThirds?: LowerThirdCue[]; breaking?: BreakingCue[] };

/** Compose all screen chrome. Never cue a lower third and BREAKING at the same time: they share one slot. */
export const Overlays: React.FC<OverlaysProps> = ({ tickerSlug, lowerThirds = [], breaking = [] }) => (
  <AbsoluteFill>
    <LogoBug />
    {lowerThirds.map((c, k) => (
      <Sequence key={`lt${k}`} from={c.from} durationInFrames={c.durationInFrames} layout="none">
        <LowerThird {...c} />
      </Sequence>
    ))}
    {breaking.map((c, k) => (
      <Sequence key={`b${k}`} from={c.from} durationInFrames={c.durationInFrames} layout="none">
        <BreakingBar headline={c.headline} />
      </Sequence>
    ))}
    {tickerSlug && <PriceTicker slug={tickerSlug} />}
  </AbsoluteFill>
);
