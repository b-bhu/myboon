import { Composition } from "remotion";
import { NewsroomEpisode } from "./NewsroomEpisode";
import { BrandKitPreview } from "./BrandKitPreview";
import { EndCard } from "./components/EndCard";

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
  </>
);
