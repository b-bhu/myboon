import { AbsoluteFill } from "remotion";

/**
 * Week-1 thumbnail. Built to read at feed size: one big question, the answer
 * underneath, and a phone showing the real storyline screen as proof.
 */

const colors = {
  ink: "#062F38",
  inkDeep: "#03232C",
  text: "#F4FBFC",
  muted: "#9FC0C7",
  accent: "#FFD24A",
  green: "#14D6A1",
};

const fontFamily =
  'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", Arial, sans-serif';

const CHAIN = [
  "U.S.–Iran conflict",
  "Strait of Hormuz closes",
  "Tankers can't get out",
  "Gas is short in India",
];

export const Thumbnail: React.FC = () => {
  return (
    <AbsoluteFill
      style={{
        background: `radial-gradient(1400px 900px at 18% 8%, ${colors.ink} 0%, ${colors.inkDeep} 70%)`,
        fontFamily,
      }}
    >
      {/* Left column: the hook */}
      <div
        style={{
          position: "absolute",
          left: 96,
          top: 96,
          bottom: 96,
          width: 1080,
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
        }}
      >
        <div>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 14,
              border: `2px solid ${colors.accent}`,
              borderRadius: 999,
              padding: "12px 26px",
              fontSize: 26,
              fontWeight: 800,
              letterSpacing: 3,
              color: colors.accent,
            }}
          >
            COLOSSEUM ETERNAL · WEEK 1
          </div>

          <div
            style={{
              fontSize: 128,
              fontWeight: 900,
              letterSpacing: -4,
              lineHeight: 0.98,
              color: colors.text,
              marginTop: 44,
            }}
          >
            Wait,
            <br />
            what
            <br />
            <span style={{ color: colors.accent }}>happened?</span>
          </div>

          <div
            style={{
              fontSize: 40,
              fontWeight: 600,
              color: colors.muted,
              marginTop: 38,
              lineHeight: 1.32,
              maxWidth: 880,
            }}
          >
            The question you ask when a price jumps.
            <br />
            myboon answers it — then you trade it.
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 18, flexWrap: "wrap" }}>
          {["Polymarket", "Pacifica", "Phoenix", "Meteora"].map((v) => (
            <div
              key={v}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                background: "rgba(11, 58, 69, 0.9)",
                border: "1px solid rgba(133, 231, 232, 0.24)",
                borderRadius: 16,
                padding: "16px 24px",
                fontSize: 30,
                fontWeight: 700,
                color: colors.text,
              }}
            >
              <div
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: 999,
                  background: colors.green,
                  boxShadow: `0 0 14px ${colors.green}`,
                }}
              />
              {v}
            </div>
          ))}
        </div>
      </div>

      {/* Right: the causal chain — the idea itself, no screenshot needed */}
      <div
        style={{
          position: "absolute",
          right: 96,
          top: "50%",
          transform: "translateY(-50%)",
          width: 620,
          background: "rgba(10, 44, 52, 0.78)",
          border: "1px solid rgba(133, 231, 232, 0.24)",
          borderRadius: 36,
          padding: "52px 48px",
          boxShadow: "0 40px 100px rgba(0,0,0,0.5)",
        }}
      >
        <div
          style={{
            fontSize: 24,
            letterSpacing: 5,
            fontWeight: 800,
            color: colors.accent,
            marginBottom: 34,
          }}
        >
          THE CHAIN
        </div>
        {CHAIN.map((label, i) => {
          const isLast = i === CHAIN.length - 1;
          return (
            <div key={label} style={{ display: "flex", gap: 22 }}>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
                <div
                  style={{
                    width: 16,
                    height: 16,
                    borderRadius: 999,
                    marginTop: 14,
                    background: isLast ? colors.accent : colors.muted,
                    boxShadow: isLast ? `0 0 20px ${colors.accent}` : "none",
                  }}
                />
                {!isLast ? (
                  <div
                    style={{
                      width: 2,
                      flexGrow: 1,
                      minHeight: 34,
                      marginTop: 6,
                      background: "rgba(133, 231, 232, 0.24)",
                    }}
                  />
                ) : null}
              </div>
              <div
                style={{
                  fontSize: 40,
                  fontWeight: 700,
                  lineHeight: 1.16,
                  paddingBottom: isLast ? 0 : 22,
                  color: isLast ? colors.accent : colors.text,
                }}
              >
                {label}
              </div>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
