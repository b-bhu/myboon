import type { Caption } from "@remotion/captions";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AbsoluteFill,
  staticFile,
  useCurrentFrame,
  useDelayRender,
  useVideoConfig,
} from "remotion";

const WORDS_PER_PAGE = 4;

const fontFamily =
  'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", Arial, sans-serif';

export const FinalPitchCaptions: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();
  const [captions, setCaptions] = useState<Caption[] | null>(null);
  const { delayRender, continueRender, cancelRender } = useDelayRender();
  const [handle] = useState(() => delayRender("Loading final pitch captions"));

  const loadCaptions = useCallback(async () => {
    try {
      const response = await fetch(
        staticFile("final-submission/captions/pitch.json"),
      );

      if (!response.ok) {
        throw new Error(`Unable to load pitch captions: ${response.status}`);
      }

      setCaptions((await response.json()) as Caption[]);
      continueRender(handle);
    } catch (error) {
      cancelRender(error instanceof Error ? error : new Error(String(error)));
    }
  }, [cancelRender, continueRender, handle]);

  useEffect(() => {
    loadCaptions();
  }, [loadCaptions]);

  const pages = useMemo(() => {
    if (!captions) {
      return [];
    }

    const result: Caption[][] = [];
    let page: Caption[] = [];

    for (const caption of captions) {
      const previous = page[page.length - 1] ?? null;
      const followsPause = previous
        ? caption.startMs - previous.endMs > 180
        : false;

      if (page.length === WORDS_PER_PAGE || followsPause) {
        result.push(page);
        page = [];
      }

      page.push(caption);
    }

    if (page.length > 0) {
      result.push(page);
    }

    return result;
  }, [captions]);

  if (!captions) {
    return null;
  }

  const timeMs = (frame / fps) * 1000;
  const scale = width / 1920;
  const page = pages.find(
    (candidate) =>
      timeMs >= candidate[0].startMs &&
      timeMs <= candidate[candidate.length - 1].endMs,
  );

  if (!page) {
    return null;
  }

  return (
    <AbsoluteFill
      style={{
        alignItems: "center",
        backgroundColor: "transparent",
        fontFamily,
        justifyContent: "flex-end",
        paddingBottom: 68 * scale,
        pointerEvents: "none",
        zIndex: 20,
      }}
    >
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "center",
          maxWidth: 1380 * scale,
          padding: `0 ${48 * scale}px`,
        }}
      >
        {page.map((caption, index) => {
          const active = timeMs >= caption.startMs && timeMs <= caption.endMs;
          const spoken = timeMs > caption.endMs;

          return (
            <span
              key={`${caption.startMs}-${index}`}
              style={{
                color: active ? "#FFD24A" : "#F4FBFC",
                fontSize: 66 * scale,
                fontWeight: 850,
                letterSpacing: -1 * scale,
                lineHeight: 1.2,
                opacity: active || spoken ? 1 : 0.44,
                scale: active ? 1.055 : 1,
                textShadow: `0 ${4 * scale}px ${18 * scale}px rgba(0, 0, 0, 0.88), 0 ${2 * scale}px ${4 * scale}px rgba(0, 0, 0, 0.96)`,
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
