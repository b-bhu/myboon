import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";

/**
 * Overlays for the "problem" section of the Week 1 vlog.
 *
 * These render on a TRANSPARENT background so they can sit on a track above
 * the existing myboon background + talking-head PIP in Resolve. All content is
 * confined to SAFE_* below, which keeps it clear of the bottom-right PIP box.
 */

const colors = {
  panel: "rgba(8, 46, 55, 0.86)",
  line: "rgba(133, 231, 232, 0.22)",
  text: "#F4FBFC",
  muted: "#9FC0C7",
  accent: "#FFD24A",
  pink: "#F0527C",
};

const fontFamily =
  'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", Arial, sans-serif';

/** Left/upper region that stays clear of the talking-head PIP (bottom-right ~42% x ~45%). */
const SAFE_LEFT = 110;
/** Clears the myboon logo lock-up in the top-left corner. */
const SAFE_TOP = 300;
const SAFE_WIDTH = 1010;

/**
 * Frame at which each chain beat lands, measured from the start of the
 * ChainOverlay clip. Derived from the pause structure of problem.mov played
 * at 111%: the four clauses land ~1.3s apart, so ~39 frames at 30fps.
 */
export const BEAT_FRAMES = [0, 39, 78, 117];

const fadeUp = (frame: number, at: number, distance = 26) => {
  const opacity = interpolate(frame, [at, at + 15], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const y = interpolate(frame, [at, at + 15], [distance, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return { opacity, transform: `translateY(${y}px)` };
};

/**
 * Card 1 — the lone headline. Cut this under
 * "One headline on its own is useless."
 */
export const HeadlineAloneOverlay: React.FC = () => {
  const frame = useCurrentFrame();
  const enter = fadeUp(frame, 0);
  // Desaturate slightly as the "useless" beat lands.
  const dim = interpolate(frame, [55, 80], [1, 0.45], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ fontFamily, backgroundColor: "transparent" }}>
      <div
        style={{
          position: "absolute",
          left: SAFE_LEFT,
          top: SAFE_TOP + 90,
          width: SAFE_WIDTH,
          ...enter,
          opacity: enter.opacity * dim,
        }}
      >
        <div
          style={{
            background: colors.panel,
            border: `1px solid ${colors.line}`,
            borderRadius: 26,
            padding: "48px 54px",
            backdropFilter: "blur(6px)",
          }}
        >
          <div
            style={{
              fontSize: 24,
              letterSpacing: 5,
              color: colors.muted,
              fontWeight: 700,
              marginBottom: 20,
            }}
          >
            ONE HEADLINE
          </div>
          <div style={{ fontSize: 68, fontWeight: 800, color: colors.text, lineHeight: 1.08 }}>
            Gas prices rise in India
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};

const CHAIN = [
  { label: "U.S.–Iran conflict", tone: "alert" as const },
  { label: "Strait of Hormuz closes", tone: "neutral" as const },
  { label: "Tankers can't get out", tone: "neutral" as const },
  { label: "Gas is short in India", tone: "accent" as const },
];

/**
 * Card 2 — the chain, assembling one beat per spoken clause.
 * Timings come from BEAT_FRAMES.
 */
export const ChainOverlay: React.FC = () => {
  const frame = useCurrentFrame();

  return (
    <AbsoluteFill style={{ fontFamily, backgroundColor: "transparent" }}>
      <div
        style={{
          position: "absolute",
          left: SAFE_LEFT,
          top: SAFE_TOP,
          width: SAFE_WIDTH,
        }}
      >
        {CHAIN.map((beat, i) => {
          const at = BEAT_FRAMES[i];
          const style = fadeUp(frame, at, 20);
          const isLast = i === CHAIN.length - 1;
          const dot =
            beat.tone === "accent"
              ? colors.accent
              : beat.tone === "alert"
                ? colors.pink
                : colors.muted;

          // The connector grows from the previous beat into this one.
          const connector = interpolate(frame, [at - 8, at + 8], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          });

          return (
            <div key={beat.label} style={{ display: "flex", gap: 28 }}>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
                <div
                  style={{
                    width: 18,
                    height: 18,
                    borderRadius: 999,
                    background: dot,
                    marginTop: 22,
                    boxShadow: beat.tone === "accent" ? `0 0 24px ${colors.accent}` : "none",
                    ...style,
                  }}
                />
                {!isLast ? (
                  <div
                    style={{
                      width: 3,
                      flexGrow: 1,
                      minHeight: 54,
                      marginTop: 8,
                      background: colors.line,
                      transformOrigin: "top",
                      transform: `scaleY(${connector})`,
                    }}
                  />
                ) : null}
              </div>
              <div
                style={{
                  paddingBottom: isLast ? 0 : 30,
                  fontSize: 60,
                  fontWeight: 800,
                  letterSpacing: -1,
                  lineHeight: 1.1,
                  color: beat.tone === "accent" ? colors.accent : colors.text,
                  textShadow: "0 2px 24px rgba(0,0,0,0.55)",
                  ...style,
                }}
              >
                {beat.label}
              </div>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
