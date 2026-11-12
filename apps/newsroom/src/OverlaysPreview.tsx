import { AbsoluteFill, Img, staticFile } from "remotion";
import { Overlays } from "./chrome/Overlays";

export const OverlaysPreview: React.FC = () => (
  <AbsoluteFill>
    <Img src={staticFile("locked/hosts/hank_master_center_mcu_v1.jpg")} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
    <Overlays
      tickerSlug="_example"
      lowerThirds={[{ from: 30, durationInFrames: 90, name: "HANK WALSH", role: "Lead Anchor" }]}
      breaking={[{ from: 150, headline: "Example headline text for layout testing" }]}
    />
  </AbsoluteFill>
);
