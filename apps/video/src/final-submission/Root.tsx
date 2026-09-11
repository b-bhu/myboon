import { Composition } from "remotion";

import { FinalSubmissionScreens } from "./FinalSubmission";
import { FinalEternalDemo } from "./FinalDemo";
import { FinalEternalPitch } from "./FinalPitch";
import {
  FINAL_ETERNAL_DEMO_TOTAL_FRAMES,
  FINAL_ETERNAL_PITCH_TOTAL_FRAMES,
  FINAL_SUBMISSION_FPS,
  FINAL_SUBMISSION_TOTAL_FRAMES,
} from "./constants";

export const FinalSubmissionRoot: React.FC = () => (
  <>
    <Composition
      id="FinalEternalDemo"
      component={FinalEternalDemo}
      durationInFrames={FINAL_ETERNAL_DEMO_TOTAL_FRAMES}
      fps={FINAL_SUBMISSION_FPS}
      width={1920}
      height={1080}
    />
    <Composition
      id="FinalEternalPitch"
      component={FinalEternalPitch}
      durationInFrames={FINAL_ETERNAL_PITCH_TOTAL_FRAMES}
      fps={FINAL_SUBMISSION_FPS}
      width={1920}
      height={1080}
    />
    <Composition
      id="FinalSubmissionScreens"
      component={FinalSubmissionScreens}
      durationInFrames={FINAL_SUBMISSION_TOTAL_FRAMES}
      fps={FINAL_SUBMISSION_FPS}
      width={1920}
      height={1080}
    />
  </>
);
