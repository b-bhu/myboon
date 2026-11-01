import { Composition } from "remotion";
import { NewsroomEpisode } from "./NewsroomEpisode";
import { BrandKitPreview } from "./BrandKitPreview";
import { EndCard } from "./components/EndCard";
import { OverlaysPreview } from "./OverlaysPreview";
import { OverVisualPreview } from "./OverVisualPreview";
import { EtfTrial, ETF_TRIAL_FRAMES } from "./episodes/EtfTrial";

export const RemotionRoot: React.FC = () => (
  <>
  <Composition
    id="NewsroomEpisode"
    component={NewsroomEpisode}
    durationInFrames={150}
    fps={30}
    width={1920}
    height={1080}
  />
  <Composition id="BrandKitPreview" component={BrandKitPreview} durationInFrames={1} fps={30} width={1920} height={1080} />
  <Composition id="EndCard" component={EndCard} durationInFrames={90} fps={30} width={1920} height={1080} />
  <Composition id="OverlaysPreview" component={OverlaysPreview} durationInFrames={240} fps={30} width={1920} height={1080} />
  <Composition id="OverVisualPreview" component={OverVisualPreview} durationInFrames={300} fps={30} width={1920} height={1080} />
  <Composition id="EtfTrial" component={EtfTrial} durationInFrames={ETF_TRIAL_FRAMES} fps={30} width={1920} height={1080} />
  </>
);
