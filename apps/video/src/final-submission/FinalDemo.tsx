import { Video } from "@remotion/media";
import {
  AbsoluteFill,
  Img,
  Sequence,
  interpolate,
  staticFile,
  useCurrentFrame,
} from "remotion";

import { FinalDemoCaptions } from "./FinalDemoCaptions";

const fontFamily =
  'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", Arial, sans-serif';

const media = {
  talkingHead: "final-submission/talking-head.mov",
  overview: "final-submission/recordings/overview-feed-wallet.mp4",
  storyCalendar: "final-submission/recordings/story-calendar.mp4",
  bitcoinPhoenix: "final-submission/recordings/bitcoin-phoenix.mp4",
  actionCenter: "final-submission/recordings/action-center.mp4",
  calendarStill: "final-submission/stills/calendar.png",
  feedStill: "final-submission/stills/feed.png",
  bitcoinStoryStill: "final-submission/stills/bitcoin-story.png",
  bitcoinTimelineStill: "final-submission/stills/bitcoin-timeline.png",
  takeActionStill: "final-submission/stills/take-action.png",
} as const;

const ProductBackground: React.FC = () => (
  <AbsoluteFill
    style={{
      backgroundColor: "#061c22",
      backgroundImage:
        "linear-gradient(rgba(76,143,151,0.075) 1px, transparent 1px), linear-gradient(90deg, rgba(76,143,151,0.075) 1px, transparent 1px), radial-gradient(circle at 78% 28%, rgba(18,101,111,0.28), transparent 38%)",
      backgroundSize: "54px 54px, 54px 54px, auto",
    }}
  />
);

const PhoneShell: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div
    style={{
      backgroundColor: "#03161b",
      border: "3px solid #2f7480",
      borderRadius: 34,
      boxShadow: "0 32px 90px rgba(0,0,0,0.52)",
      height: 1030,
      overflow: "hidden",
      position: "absolute",
      right: 118,
      top: 25,
      width: 464,
      zIndex: 3,
    }}
  >
    {children}
  </div>
);

const PhoneVideoStyle: React.CSSProperties = {
  height: "100%",
  objectFit: "cover",
  width: "100%",
};

const PhoneStill: React.FC<{ src: string }> = ({ src }) => {
  const frame = useCurrentFrame();

  return (
    <Img
      src={staticFile(src)}
      style={{
        height: "100%",
        objectFit: "cover",
        scale: interpolate(frame, [0, 180], [1, 1.012], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        }),
        width: "100%",
      }}
    />
  );
};

const SceneLabel: React.FC<{
  eyebrow: string;
  title: React.ReactNode;
}> = ({ eyebrow, title }) => {
  const frame = useCurrentFrame();

  return (
    <div
      style={{
        left: 96,
        opacity: interpolate(frame, [3, 18], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        }),
        position: "absolute",
        top: 78,
        translate: `0 ${interpolate(frame, [3, 18], [16, 0], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        })}px`,
        width: 940,
        zIndex: 5,
      }}
    >
      <div
        style={{
          color: "#FFD24A",
          fontFamily,
          fontSize: 23,
          fontWeight: 850,
          letterSpacing: 4.5,
          textTransform: "uppercase",
        }}
      >
        {eyebrow}
      </div>
      <div
        style={{
          color: "#F4FBFC",
          fontFamily,
          fontSize: 61,
          fontWeight: 850,
          letterSpacing: -2.3,
          lineHeight: 1.04,
          marginTop: 20,
          maxWidth: 920,
        }}
      >
        {title}
      </div>
    </div>
  );
};

const PresenterPip: React.FC = () => (
  <div
    style={{
      backgroundColor: "#082e37",
      border: "3px solid rgba(255, 210, 74, 0.92)",
      borderRadius: 32,
      bottom: 54,
      boxShadow: "0 24px 70px rgba(0,0,0,0.52)",
      height: 455,
      left: 58,
      overflow: "hidden",
      position: "absolute",
      width: 352,
      zIndex: 8,
    }}
  >
    <Video
      muted
      objectFit="cover"
      src={staticFile(media.talkingHead)}
      style={{ height: "100%", width: "100%" }}
      trimBefore={875}
    />
  </div>
);

const ProductTimeline: React.FC = () => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 8, 3197, 3207], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ opacity }}>
      <ProductBackground />

      <Sequence name="Connected wallet" durationInFrames={152}>
        <SceneLabel eyebrow="Connected wallet" title={<>Start with your Solana wallet.</>} />
        <PhoneShell>
          <Video
            muted
            src={staticFile(media.overview)}
            style={PhoneVideoStyle}
            trimBefore={525}
          />
        </PhoneShell>
      </Sequence>

      <Sequence name="Home overview" from={152} durationInFrames={433}>
        <SceneLabel
          eyebrow="Home"
          title={<>Feed, markets, and positions—together.</>}
        />
        <PhoneShell>
          <Video
            muted
            src={staticFile(media.overview)}
            style={PhoneVideoStyle}
            trimBefore={171}
          />
        </PhoneShell>
      </Sequence>

      <Sequence name="Feed analyst" from={585} durationInFrames={512}>
        <SceneLabel eyebrow="Feed" title={<>Your personal market analyst.</>} />
        <PhoneShell>
          <Video
            muted
            src={staticFile(media.storyCalendar)}
            style={PhoneVideoStyle}
            trimBefore={360}
          />
        </PhoneShell>
      </Sequence>

      <Sequence name="Latest market updates" from={1097} durationInFrames={137}>
        <SceneLabel eyebrow="Latest" title={<>Updates from across the market.</>} />
        <PhoneShell>
          <Video
            muted
            src={staticFile(media.storyCalendar)}
            style={PhoneVideoStyle}
            trimBefore={1140}
          />
        </PhoneShell>
      </Sequence>

      <Sequence name="Market calendar" from={1234} durationInFrames={103}>
        <SceneLabel eyebrow="Market calendar" title={<>Key dates worth watching.</>} />
        <PhoneShell>
          <PhoneStill src={media.calendarStill} />
        </PhoneShell>
      </Sequence>

      <Sequence name="Bitcoin story" from={1337} durationInFrames={470}>
        <SceneLabel
          eyebrow="Bitcoin story"
          title={<>Latest development and chronological context.</>}
        />
        <Sequence durationInFrames={226} layout="none">
          <PhoneShell>
            <PhoneStill src={media.bitcoinStoryStill} />
          </PhoneShell>
        </Sequence>
        <Sequence from={226} durationInFrames={244} layout="none">
          <PhoneShell>
            <PhoneStill src={media.bitcoinTimelineStill} />
          </PhoneShell>
        </Sequence>
      </Sequence>

      <Sequence name="Take Action handoff" from={1807} durationInFrames={303}>
        <SceneLabel eyebrow="Take Action" title={<>Story to BTC perpetual market.</>} />
        <Sequence durationInFrames={148} layout="none">
          <PhoneShell>
            <PhoneStill src={media.takeActionStill} />
          </PhoneShell>
        </Sequence>
        <Sequence from={148} durationInFrames={155} layout="none">
          <PhoneShell>
            <Video
              muted
              src={staticFile(media.bitcoinPhoenix)}
              style={PhoneVideoStyle}
              trimBefore={870}
            />
          </PhoneShell>
        </Sequence>
      </Sequence>

      <Sequence name="Phoenix order" from={2110} durationInFrames={212}>
        <SceneLabel eyebrow="Phoenix BTC-PERP" title={<>Check the market. Place the order.</>} />
        <PhoneShell>
          <Video
            muted
            src={staticFile(media.bitcoinPhoenix)}
            style={PhoneVideoStyle}
            trimBefore={1200}
          />
        </PhoneShell>
      </Sequence>

      <Sequence name="Solana action center" from={2322} durationInFrames={564}>
        <SceneLabel
          eyebrow="Solana action center"
          title={<>Perpetuals, swaps, liquidity, and positions.</>}
        />
        <Sequence durationInFrames={195} layout="none">
          <PhoneShell>
            <Video
              muted
              src={staticFile(media.actionCenter)}
              style={PhoneVideoStyle}
              trimBefore={240}
            />
          </PhoneShell>
        </Sequence>
        <Sequence from={195} durationInFrames={210} layout="none">
          <PhoneShell>
            <Video
              muted
              src={staticFile(media.actionCenter)}
              style={PhoneVideoStyle}
              trimBefore={1605}
            />
          </PhoneShell>
        </Sequence>
        <Sequence from={405} durationInFrames={159} layout="none">
          <PhoneShell>
            <Video
              muted
              src={staticFile(media.actionCenter)}
              style={PhoneVideoStyle}
              trimBefore={1395}
            />
          </PhoneShell>
        </Sequence>
      </Sequence>

      <Sequence name="Complete product" from={2886} durationInFrames={322}>
        <SceneLabel
          eyebrow="One mobile experience"
          title={<>Understand, act, and track what you own.</>}
        />
        <PhoneShell>
          <PhoneStill src={media.feedStill} />
        </PhoneShell>
      </Sequence>

      <PresenterPip />
    </AbsoluteFill>
  );
};

export const FinalEternalDemo: React.FC = () => (
  <AbsoluteFill style={{ backgroundColor: "#061c22", fontFamily }}>
    <Video
      src={staticFile(media.talkingHead)}
      style={{ height: "100%", objectFit: "cover", width: "100%" }}
      trimBefore={18}
      volume={1.2}
    />

    <Sequence
      name="Product demonstration"
      from={857}
      durationInFrames={3208}
    >
      <ProductTimeline />
    </Sequence>

    <FinalDemoCaptions />
  </AbsoluteFill>
);
