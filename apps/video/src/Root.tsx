import { Composition } from "remotion";
import { Main } from "./Main";
import { EntityKnowledgeLayer } from "./vlog/EntityKnowledgeLayer";
import { VlogGeneralBackground, VlogIntro } from "./vlog/VlogIntro";
import {
  ChainBuild,
  HeadlineAlone,
  ShippedCard,
  StorylinesCard,
} from "./week1/ChainSlides";
import { ChainOverlay, HeadlineAloneOverlay } from "./week1/ProblemOverlay";
import { Captions } from "./week1/Captions";
import { Thumbnail } from "./week1/Thumbnail";
import { Week2Captions } from "./week2/Captions";

/** Source clip lengths, in frames at 30fps, for the caption compositions. */
const CAPTION_SECTIONS = [
  { id: "intro", frames: 351 },
  { id: "problem", frames: 1066 },
  { id: "solution", frames: 1055 },
  { id: "outer", frames: 1223 },
] as const;
import { WorldCupMatchCard } from "./world-cup/WorldCupMatchCard";
import { defaultWorldCupMatchCardProps } from "./world-cup/schema";

const WorldCupMatchCardComposition = WorldCupMatchCard as unknown as React.FC<Record<string, unknown>>;

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="Main"
        component={Main}
        durationInFrames={300}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="VlogIntro"
        component={VlogIntro}
        durationInFrames={120}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="VlogGeneralBackground"
        component={VlogGeneralBackground}
        durationInFrames={1}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="EntityKnowledgeLayer"
        component={EntityKnowledgeLayer}
        durationInFrames={1}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="Week1Thumbnail"
        component={Thumbnail}
        durationInFrames={1}
        fps={30}
        width={1920}
        height={1080}
      />
      {CAPTION_SECTIONS.map(({ id, frames }) => (
        <Composition
          key={id}
          id={`Week1Captions${id.charAt(0).toUpperCase()}${id.slice(1)}`}
          component={Captions}
          durationInFrames={frames}
          fps={30}
          width={1280}
          height={720}
          defaultProps={{ section: id }}
        />
      ))}
      <Composition
        id="Week2Captions"
        component={Week2Captions}
        durationInFrames={2292}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="Week1ProblemHeadline"
        component={HeadlineAloneOverlay}
        durationInFrames={120}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="Week1ProblemChain"
        component={ChainOverlay}
        durationInFrames={165}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="Week1HeadlineAlone"
        component={HeadlineAlone}
        durationInFrames={90}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="Week1ChainBuild"
        component={ChainBuild}
        durationInFrames={150}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="Week1Storylines"
        component={StorylinesCard}
        durationInFrames={90}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="Week1Shipped"
        component={ShippedCard}
        durationInFrames={120}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="WorldCupMatchCard"
        component={WorldCupMatchCardComposition}
        durationInFrames={1}
        fps={30}
        width={1200}
        height={675}
        defaultProps={defaultWorldCupMatchCardProps}
      />
    </>
  );
};
