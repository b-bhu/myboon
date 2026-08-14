import type { Caption } from "@remotion/captions";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";

import captionData from "../../out/week2-assets/captions/eternal_week_two.json";

const captions = captionData as Caption[];

const colors = {
  text: "#F4FBFC",
  active: "#FFD24A",
  shadow: "rgba(0, 0, 0, 0.78)",
};

const fontFamily =
  'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", Arial, sans-serif';

/** Match Week 1: four large words on screen with the spoken word highlighted. */
const WORDS_PER_PAGE = 4;

const chunk = <T,>(items: T[], size: number): T[][] => {
  const pages: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    pages.push(items.slice(index, index + size));
  }
  return pages;
};

const pages = chunk(captions, WORDS_PER_PAGE);

/**
 * Transparent Week 2 caption overlay for DaVinci Resolve.
 * Timings start at frame zero of the locked `eternal_week_two.mp4` export.
 */
export const Week2Captions: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();
  const timeMs = (frame / fps) * 1000;
  const scale = width / 1920;

  const page = pages.find(
    (candidate) =>
      timeMs >= candidate[0].startMs &&
      timeMs <= candidate[candidate.length - 1].endMs,
  );

  if (!page) {
    return <AbsoluteFill style={{ backgroundColor: "transparent" }} />;
  }

  return (
    <AbsoluteFill
      style={{
        alignItems: "center",
        backgroundColor: "transparent",
        fontFamily,
        justifyContent: "flex-end",
        paddingBottom: 150 * scale,
      }}
    >
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "center",
          maxWidth: 1500 * scale,
          padding: `0 ${60 * scale}px`,
        }}
      >
        {page.map((caption, index) => {
          const active = timeMs >= caption.startMs && timeMs <= caption.endMs;
          const spoken = timeMs > caption.endMs;

          return (
            <span
              key={`${caption.startMs}-${index}`}
              style={{
                color: active ? colors.active : colors.text,
                fontSize: 78 * scale,
                fontWeight: 800,
                letterSpacing: -1 * scale,
                lineHeight: 1.24,
                opacity: active || spoken ? 1 : 0.45,
                scale: active ? 1.06 : 1,
                textShadow: `0 ${4 * scale}px ${18 * scale}px ${colors.shadow}, 0 ${2 * scale}px ${4 * scale}px ${colors.shadow}`,
                transformOrigin: "center bottom",
                whiteSpace: "pre",
              }}
            >
              {caption.text}
            </span>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
