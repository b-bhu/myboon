import { interpolate, useCurrentFrame, Easing } from "remotion";
import { colors, fonts } from "../brand";
import { layout, slotBottom } from "./layout";

type Props = { name?: string; role?: string; headline?: string; durationInFrames: number };

/** Name + role, or a single headline line. Wipes in/out over ~0.3 s. Use inside a <Sequence>. */
export const LowerThird: React.FC<Props> = ({ name, role, headline, durationInFrames }) => {
  const f = useCurrentFrame();
  const e = { easing: Easing.out(Easing.cubic), extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
  const inP = interpolate(f, [0, layout.inFrames], [0, 1], e);
  const outP = interpolate(f, [durationInFrames - layout.inFrames, durationInFrames], [0, 1], e);
  const clip = `inset(0 ${(1 - inP) * 100}% 0 ${outP * 100}%)`;
  return (
    <div style={{ position: "absolute", left: layout.margin, bottom: slotBottom, clipPath: clip, background: colors.ground, borderTop: `2px solid ${colors.borderMuted}`, padding: "18px 32px 20px" }}>
      {headline ? (
        <div style={{ fontFamily: fonts.headline, fontWeight: 500, fontSize: 44, color: colors.bone, letterSpacing: -0.3 }}>{headline}</div>
      ) : (
        <>
          <div style={{ fontFamily: fonts.headline, fontWeight: 700, fontSize: 46, color: colors.bone, letterSpacing: 1, lineHeight: 1.05 }}>{name}</div>
          <div style={{ fontFamily: fonts.body, fontWeight: 500, fontSize: 28, color: colors.textDim, marginTop: 6 }}>{role}</div>
        </>
      )}
    </div>
  );
};
