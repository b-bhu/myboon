import { Audio, Video } from "@remotion/media";
import { AbsoluteFill, staticFile } from "remotion";

import { FinalPitchCaptions } from "./FinalPitchCaptions";

export const FinalEternalPitch: React.FC = () => (
  <AbsoluteFill style={{ backgroundColor: "#000" }}>
    <Video
      muted
      objectFit="cover"
      src={staticFile("final-submission/pitch-head.mov")}
      style={{ height: "100%", width: "100%" }}
    />
    <Audio src={staticFile("final-submission/pitch-audio.wav")} />
    <FinalPitchCaptions />
  </AbsoluteFill>
);
