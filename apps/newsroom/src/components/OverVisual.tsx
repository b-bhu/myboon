import { AbsoluteFill, Easing, Img, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { colors, radius } from "../brand";
import { overVisualSafe as safe } from "../chrome/layout";

/** Locked OVER VISUAL push-in style. Real assets only, no generation. Hard cuts in/out (no fades). */
export type OverVisualProps = {
  src: string;                 // staticFile() url of the real screenshot/chart
  assetWidth: number;          // intrinsic px
  assetHeight: number;
  mode: "post" | "chart";      // post: centred, ~92% of safe height; chart: fill safe width
  lineSeconds: number;         // voice line length; shot = line + HOLD_TAIL
  focus?: { x: number; y: number }; // 0-1 within the asset; push drifts gently toward it
  highlight?: { x: number; y: number; w: number; h: number; at: number }; // 0-1 asset coords, at = seconds
};

export const PUSH = { from: 1.0, to: 1.06, landBeforeEnd: 0.5 } as const; // locked
export const HOLD_TAIL = 0.3; // seconds after the line
export const overVisualFrames = (lineSeconds: number, fps: number) => Math.round((lineSeconds + HOLD_TAIL) * fps);

export const OverVisual: React.FC<OverVisualProps> = ({ src, assetWidth, assetHeight, mode, lineSeconds, focus, highlight }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const total = overVisualFrames(lineSeconds, fps);
  const landAt = Math.max(1, total - Math.round(PUSH.landBeforeEnd * fps));

  // Fit inside safe area. Post: 92% of safe height. Chart: full safe width. Never exceed the box (at end scale too).
  const maxW = safe.width / PUSH.to, maxH = safe.height / PUSH.to;
  let w: number, h: number;
  if (mode === "post") { h = safe.height * 0.92; w = (h * assetWidth) / assetHeight; }
  else { w = safe.width; h = (w * assetHeight) / assetWidth; }
  const k = Math.min(1, maxW / w, maxH / h); w *= k; h *= k;
  const left = safe.x + (safe.width - w) / 2, top = safe.y + (safe.height - h) / 2;

  const t = interpolate(frame, [0, landAt], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });
  const scale = PUSH.from + (PUSH.to - PUSH.from) * t;
  const f = focus ?? { x: 0.5, y: 0.5 };
  const origin = `${f.x * 100}% ${f.y * 100}%`; // drift toward focus as it scales

  const hlProgress = highlight ? interpolate(frame, [highlight.at * fps, highlight.at * fps + 9], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) : 0;

  return (
    <AbsoluteFill style={{ background: colors.walletCore }}>
      <div style={{ position: "absolute", left, top, width: w, height: h, transform: `scale(${scale})`, transformOrigin: origin }}>
        <Img src={src} style={{ width: "100%", height: "100%", display: "block", borderRadius: radius.sm, outline: `1px solid ${colors.borderMuted}` }} />
        {highlight && hlProgress > 0 && (
          <div style={{
            position: "absolute", left: `${highlight.x * 100}%`, top: `${highlight.y * 100}%`,
            width: `${highlight.w * 100}%`, height: `${highlight.h * 100}%`,
            border: `3px solid ${colors.accent}`, borderRadius: radius.xs,
            clipPath: `inset(0 ${(1 - hlProgress) * 100}% 0 0)`,
          }} />
        )}
      </div>
    </AbsoluteFill>
  );
};
