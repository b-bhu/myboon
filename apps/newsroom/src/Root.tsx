import { Composition } from "remotion";
import { NewsroomEpisode } from "./NewsroomEpisode";

export const RemotionRoot: React.FC = () => (
  <Composition
    id="NewsroomEpisode"
    component={NewsroomEpisode}
    durationInFrames={150}
    fps={30}
    width={1920}
    height={1080}
  />
);
