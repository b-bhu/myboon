import { AbsoluteFill, Img, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { colors, logos } from "../brand";

/** LOCKED end card: MyBoon wordmark fades up (~0.5 s) on walletCore and holds. Silent. */
export const EndCard: React.FC<{ fadeSeconds?: number; wordmarkWidth?: number }> = ({
  fadeSeconds = 0.5,
  wordmarkWidth = 630,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const opacity = interpolate(frame, [0, fadeSeconds * fps], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <AbsoluteFill style={{ backgroundColor: colors.walletCore, justifyContent: "center", alignItems: "center" }}>
      <Img src={logos.wordmark} style={{ width: wordmarkWidth, opacity }} />
    </AbsoluteFill>
  );
};
