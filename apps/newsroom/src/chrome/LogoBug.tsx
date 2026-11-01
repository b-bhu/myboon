import { Img, interpolate, useCurrentFrame } from "remotion";
import { logos } from "../brand";
import { layout } from "./layout";

export const LogoBug: React.FC = () => {
  const f = useCurrentFrame();
  const opacity = interpolate(f, [0, 15], [0, 1], { extrapolateRight: "clamp" });
  return <Img src={logos.wordmark} style={{ position: "absolute", top: layout.margin - 16, left: layout.margin, height: layout.logoHeight * 1.6, opacity }} />;
};
