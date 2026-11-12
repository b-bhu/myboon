import { interpolate, useCurrentFrame } from "remotion";
import { colors, fonts, letterSpacing, radius, spacing } from "../brand";
import { layout } from "./layout";

/** Top-right broadcast date. Body chrome only; same fade as LogoBug. */
export const DateBadge: React.FC<{ label: string }> = ({ label }) => {
  const f = useCurrentFrame();
  const opacity = interpolate(f, [0, 15], [0, 1], { extrapolateRight: "clamp" });
  return (
    <div
      style={{
        position: "absolute",
        top: layout.margin - 8,
        right: layout.margin,
        opacity,
        padding: `${spacing.xs}px ${spacing.md}px`,
        borderRadius: radius.sm,
        border: `1px solid ${colors.borderMuted}`,
        background: colors.walletCore,
        color: colors.bone,
        fontFamily: fonts.headline,
        fontSize: 26,
        fontWeight: 500,
        letterSpacing: letterSpacing.mono,
        lineHeight: 1,
      }}
    >
      {label}
    </div>
  );
};
