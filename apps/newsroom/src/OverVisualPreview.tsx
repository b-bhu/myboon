import { AbsoluteFill, Sequence, staticFile, useVideoConfig } from "remotion";
import { OverVisual, overVisualFrames } from "./components/OverVisual";
import { Overlays } from "./chrome/Overlays";

export const OverVisualPreview: React.FC = () => {
  const { fps } = useVideoConfig();
  const a = overVisualFrames(4.7, fps); // 5 s
  return (
    <AbsoluteFill>
      <Sequence durationInFrames={a}>
        <OverVisual src={staticFile("episodes/_example/visuals/post.png")} assetWidth={1210} assetHeight={1074} mode="post" lineSeconds={4.7} focus={{ x: 0.5, y: 0.3 }} />
      </Sequence>
      <Sequence from={a} durationInFrames={a}>
        <OverVisual src={staticFile("episodes/_example/visuals/chart.png")} assetWidth={2676} assetHeight={1074} mode="chart" lineSeconds={4.7}
          focus={{ x: 0.1, y: 0.2 }} highlight={{ x: 0.004, y: 0.15, w: 0.2, h: 0.09, at: 1.5 }} />
      </Sequence>
      <Overlays tickerSlug="_example" />
    </AbsoluteFill>
  );
};
