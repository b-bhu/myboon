import { interpolate, useCurrentFrame, Easing } from "remotion";
import { colors, fonts } from "../brand";
import { layout, slotBottom } from "./layout";

/** Full-width (inside margins) BREAKING bar. Vermillion is used only here and for ticker down moves. */
export const BreakingBar: React.FC<{ headline: string }> = ({ headline }) => {
  const f = useCurrentFrame();
  const p = interpolate(f, [0, layout.inFrames], [0, 1], { easing: Easing.out(Easing.cubic), extrapolateRight: "clamp" });
  return (
    <div style={{ position: "absolute", left: layout.margin, right: layout.margin, bottom: slotBottom, height: 84, display: "flex", clipPath: `inset(0 ${(1 - p) * 100}% 0 0)` }}>
      <div style={{ background: colors.vermillion, color: colors.bone, fontFamily: fonts.headline, fontWeight: 700, fontSize: 38, letterSpacing: 2, display: "flex", alignItems: "center", padding: "0 28px" }}>BREAKING</div>
      <div style={{ flex: 1, background: colors.ground, color: colors.bone, fontFamily: fonts.headline, fontWeight: 500, fontSize: 40, display: "flex", alignItems: "center", padding: "0 28px", whiteSpace: "nowrap", overflow: "hidden" }}>{headline}</div>
    </div>
  );
};
