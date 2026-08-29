import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";

import intro from "./data/intro.json";
import outer from "./data/outer.json";
import problem from "./data/problem.json";
import solution from "./data/solution.json";

/**
 * Word-by-word captions for the week-1 vlog, rendered on a transparent
 * background so each section can sit on its own track above the talking head
 * in Resolve. One composition per source clip, so the timings stay anchored to
 * that clip's own audio no matter where it lands on the timeline.
 */

export type Word = { word: string; start: number; end: number };

const WORDS: Record<string, Word[]> = {
  intro: intro as Word[],
  problem: problem as Word[],
  solution: solution as Word[],
  outer: outer as Word[],
};

const colors = {
  text: "#F4FBFC",
  active: "#FFD24A",
  shadow: "rgba(0, 0, 0, 0.72)",
};

const fontFamily =
  'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", Arial, sans-serif';

/** Words shown at once. A short window keeps the type large and readable. */
const WINDOW = 4;

/** Group the word list into fixed-size chunks that swap as a unit. */
const chunk = (words: Word[], size: number): Word[][] => {
  const out: Word[][] = [];
  for (let i = 0; i < words.length; i += size) out.push(words.slice(i, i + size));
  return out;
};

export const Captions: React.FC<{ section?: string }> = ({ section = "intro" }) => {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();
  const time = frame / fps;

  // Sizes below are authored against a 1920-wide frame; scale so the captions
  // look identical when rendered at a smaller resolution.
  const s = width / 1920;

  const words = WORDS[section] ?? [];
  const groups = chunk(words, WINDOW);

  const group = groups.find((g) => time >= g[0].start && time <= g[g.length - 1].end);

  if (!group) return <AbsoluteFill style={{ backgroundColor: "transparent" }} />;

  return (
    <AbsoluteFill
      style={{
        fontFamily,
        backgroundColor: "transparent",
        alignItems: "center",
        justifyContent: "flex-end",
        paddingBottom: 150 * s,
      }}
    >
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "center",
          gap: `0 ${22 * s}px`,
          maxWidth: 1500 * s,
          padding: `0 ${60 * s}px`,
        }}
      >
        {group.map((w, i) => {
          const isActive = time >= w.start && time <= w.end;
          const spoken = time > w.end;
          return (
            <span
              key={`${w.start}-${i}`}
              style={{
                fontSize: 78 * s,
                fontWeight: 800,
                letterSpacing: -1 * s,
                lineHeight: 1.24,
                color: isActive ? colors.active : colors.text,
                opacity: isActive || spoken ? 1 : 0.45,
                transform: isActive ? "scale(1.06)" : "scale(1)",
                transformOrigin: "center bottom",
                textShadow: `0 ${4 * s}px ${18 * s}px ${colors.shadow}, 0 ${2 * s}px ${4 * s}px ${colors.shadow}`,
                transition: "none",
              }}
            >
              {w.word}
            </span>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
