import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";

const colors = {
  ink: "#062F38",
  inkDeep: "#03232C",
  panel: "#0B3A45",
  line: "rgba(133, 231, 232, 0.22)",
  text: "#F4FBFC",
  muted: "#9FC0C7",
  accent: "#FFD24A",
  green: "#14D6A1",
  pink: "#F0527C",
};

const fontFamily =
  'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", Arial, sans-serif';

const Backdrop: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <AbsoluteFill
    style={{
      background: `radial-gradient(1200px 700px at 22% 12%, ${colors.ink} 0%, ${colors.inkDeep} 68%)`,
      fontFamily,
    }}
  >
    {children}
  </AbsoluteFill>
);

/**
 * One beat in the causal chain. `index` drives the stagger so the chain
 * assembles link by link, matching how the line is spoken.
 */
const Beat: React.FC<{
  index: number;
  label: string;
  sub?: string;
  tone?: "neutral" | "accent" | "alert";
  staggered: boolean;
}> = ({ index, label, sub, tone = "neutral", staggered }) => {
  const frame = useCurrentFrame();
  const delay = staggered ? index * 18 : 0;
  const opacity = interpolate(frame, [delay, delay + 14], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const x = interpolate(frame, [delay, delay + 14], [-28, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const dot =
    tone === "accent" ? colors.accent : tone === "alert" ? colors.pink : colors.muted;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 30,
        opacity,
        transform: `translateX(${x}px)`,
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", paddingTop: 14 }}>
        <div
          style={{
            width: 20,
            height: 20,
            borderRadius: 999,
            background: dot,
            boxShadow: tone === "accent" ? `0 0 26px ${colors.accent}` : "none",
          }}
        />
      </div>
      <div style={{ paddingBottom: 34 }}>
        <div
          style={{
            fontSize: 52,
            fontWeight: 800,
            letterSpacing: -1,
            color: tone === "accent" ? colors.accent : colors.text,
            lineHeight: 1.12,
          }}
        >
          {label}
        </div>
        {sub ? (
          <div style={{ fontSize: 30, color: colors.muted, marginTop: 10, fontWeight: 500 }}>
            {sub}
          </div>
        ) : null}
      </div>
    </div>
  );
};

const CHAIN: Array<{ label: string; sub?: string; tone?: "neutral" | "accent" | "alert" }> = [
  { label: "U.S.–Iran conflict", sub: "Strikes escalate", tone: "alert" },
  { label: "Strait of Hormuz closes", sub: "Shipping lane blocked" },
  { label: "Tankers can't get out", sub: "Supply stalls" },
  { label: "Gas prices rise in India", sub: "The headline you actually see", tone: "accent" },
];

/** The full chain, assembling beat by beat. Use under the Hormuz VO. */
export const ChainBuild: React.FC = () => (
  <Backdrop>
    <AbsoluteFill
      style={{
        justifyContent: "center",
        padding: "0 150px",
      }}
    >
      <div
        style={{
          fontSize: 30,
          letterSpacing: 6,
          color: colors.accent,
          fontWeight: 800,
          marginBottom: 54,
        }}
      >
        THE CHAIN
      </div>
      <div
        style={{
          borderLeft: `3px solid ${colors.line}`,
          paddingLeft: 6,
        }}
      >
        {CHAIN.map((beat, i) => (
          <Beat key={beat.label} index={i} staggered {...beat} />
        ))}
      </div>
    </AbsoluteFill>
  </Backdrop>
);

/**
 * Headline-alone vs chain. Sets up why one headline is useless —
 * cut this in right before ChainBuild.
 */
export const HeadlineAlone: React.FC = () => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 16], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <Backdrop>
      <AbsoluteFill
        style={{
          alignItems: "center",
          justifyContent: "center",
          padding: 140,
          opacity,
        }}
      >
        <div
          style={{
            background: colors.panel,
            border: `1px solid ${colors.line}`,
            borderRadius: 28,
            padding: "56px 64px",
            maxWidth: 1180,
          }}
        >
          <div
            style={{
              fontSize: 24,
              letterSpacing: 4,
              color: colors.muted,
              fontWeight: 700,
              marginBottom: 22,
            }}
          >
            ONE HEADLINE
          </div>
          <div style={{ fontSize: 72, fontWeight: 800, color: colors.text, lineHeight: 1.1 }}>
            Gas prices rise in India
          </div>
          <div style={{ fontSize: 34, color: colors.muted, marginTop: 30, fontWeight: 500 }}>
            Tells you nothing on its own.
          </div>
        </div>
      </AbsoluteFill>
    </Backdrop>
  );
};

/** Closing card: the reframe from headlines to storylines. */
export const StorylinesCard: React.FC = () => {
  const frame = useCurrentFrame();
  const o1 = interpolate(frame, [0, 14], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const o2 = interpolate(frame, [16, 32], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <Backdrop>
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", gap: 26 }}>
        <div
          style={{
            fontSize: 76,
            fontWeight: 800,
            color: colors.muted,
            textDecoration: "line-through",
            opacity: o1,
          }}
        >
          Headlines
        </div>
        <div
          style={{
            fontSize: 132,
            fontWeight: 900,
            letterSpacing: -3,
            color: colors.accent,
            opacity: o2,
          }}
        >
          Storylines
        </div>
      </AbsoluteFill>
    </Backdrop>
  );
};

/** Week-1 shipped card: the four venues, as proof of work. */
export const ShippedCard: React.FC = () => {
  const frame = useCurrentFrame();
  const venues = ["Polymarket", "Pacifica", "Phoenix", "Meteora"];

  return (
    <Backdrop>
      <AbsoluteFill style={{ justifyContent: "center", padding: "0 150px" }}>
        <div style={{ fontSize: 30, letterSpacing: 6, color: colors.accent, fontWeight: 800 }}>
          WEEK 1 — SHIPPED
        </div>
        <div
          style={{
            fontSize: 72,
            fontWeight: 800,
            color: colors.text,
            marginTop: 26,
            marginBottom: 70,
            letterSpacing: -1.5,
          }}
        >
          Four venues, live in the app
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 30,
          }}
        >
        {venues.map((v, i) => {
          const delay = i * 12;
          const opacity = interpolate(frame, [delay, delay + 14], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          });
          const y = interpolate(frame, [delay, delay + 14], [22, 0], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          });
          return (
            <div
              key={v}
              style={{
                background: colors.panel,
                border: `1px solid ${colors.line}`,
                borderRadius: 22,
                padding: "38px 42px",
                fontSize: 50,
                fontWeight: 800,
                color: colors.text,
                opacity,
                transform: `translateY(${y}px)`,
                display: "flex",
                alignItems: "center",
                gap: 20,
              }}
            >
              <div
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: 999,
                  background: colors.green,
                  boxShadow: `0 0 18px ${colors.green}`,
                }}
              />
              {v}
            </div>
          );
        })}
        </div>
      </AbsoluteFill>
    </Backdrop>
  );
};
