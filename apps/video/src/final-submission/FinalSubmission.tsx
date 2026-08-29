import { Video } from "@remotion/media";
import {
  AbsoluteFill,
  Img,
  Sequence,
  interpolate,
  staticFile,
  useCurrentFrame,
} from "remotion";

import {
  FINAL_SUBMISSION_SCENE_FRAMES,
  FINAL_SUBMISSION_SCENE_STARTS,
  secondsToFrames,
} from "./constants";

const fontFamily =
  'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", Arial, sans-serif';

const colors = {
  background: "#061c22",
  board: "#082832",
  border: "#2f7480",
  muted: "#9dbbc0",
  text: "#f4fbfc",
  yellow: "#ffd24a",
};

const recordings = {
  overview: "final-submission/recordings/overview-feed-wallet.mp4",
  storyCalendar: "final-submission/recordings/story-calendar.mp4",
  bitcoinPhoenix: "final-submission/recordings/bitcoin-phoenix.mp4",
  actionCenter: "final-submission/recordings/action-center.mp4",
} as const;

const stills = {
  feed: "final-submission/stills/feed.png",
  calendar: "final-submission/stills/calendar.png",
  bitcoinStory: "final-submission/stills/bitcoin-story.png",
  bitcoinTimeline: "final-submission/stills/bitcoin-timeline.png",
  takeAction: "final-submission/stills/take-action.png",
  phoenixContext: "final-submission/stills/phoenix-context.png",
  tradeOrder: "final-submission/stills/trade-order.png",
  marketGrid: "final-submission/stills/market-grid.png",
  wallet: "final-submission/stills/wallet.png",
  swapSuccess: "final-submission/stills/swap-success.png",
} as const;

const GridBackground: React.FC = () => (
  <AbsoluteFill
    style={{
      backgroundColor: colors.background,
      backgroundImage:
        "linear-gradient(rgba(76,143,151,0.08) 1px, transparent 1px), linear-gradient(90deg, rgba(76,143,151,0.08) 1px, transparent 1px), radial-gradient(circle at 78% 28%, rgba(18,101,111,0.30), transparent 38%)",
      backgroundSize: "54px 54px, 54px 54px, auto",
    }}
  />
);

const SceneFade: React.FC<{
  duration: number;
  children: React.ReactNode;
}> = ({ duration, children }) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(
    frame,
    [0, 8, Math.max(duration - 8, 9), duration - 1],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );

  return <AbsoluteFill style={{ opacity }}>{children}</AbsoluteFill>;
};

const SceneCopy: React.FC<{
  eyebrow: string;
  title: React.ReactNode;
  body: React.ReactNode;
}> = ({ eyebrow, title, body }) => {
  const frame = useCurrentFrame();
  const progress = interpolate(frame, [4, 22], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <div
      style={{
        left: 110,
        opacity: progress,
        position: "absolute",
        top: 105,
        transform: `translateY(${(1 - progress) * 18}px)`,
        width: 930,
        zIndex: 5,
      }}
    >
      <div
        style={{
          color: colors.yellow,
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
          color: colors.text,
          fontFamily,
          fontSize: 65,
          fontWeight: 850,
          letterSpacing: -2.5,
          lineHeight: 1.03,
          marginTop: 22,
        }}
      >
        {title}
      </div>
      <div
        style={{
          color: colors.muted,
          fontFamily,
          fontSize: 29,
          fontWeight: 520,
          lineHeight: 1.42,
          marginTop: 30,
          maxWidth: 790,
        }}
      >
        {body}
      </div>
    </div>
  );
};

const PhoneShell: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div
    style={{
      backgroundColor: "#03161b",
      border: `3px solid ${colors.border}`,
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

const PhoneVideo: React.FC<{
  src: string;
  trimBeforeSeconds: number;
  playbackRate?: number;
}> = ({ src, trimBeforeSeconds, playbackRate = 1 }) => (
  <Video
    muted
    playbackRate={playbackRate}
    src={staticFile(src)}
    style={{ height: "100%", objectFit: "cover", width: "100%" }}
    trimBefore={secondsToFrames(trimBeforeSeconds)}
  />
);

const PhoneStill: React.FC<{ src: string; zoom?: number }> = ({
  src,
  zoom = 1,
}) => {
  const frame = useCurrentFrame();
  const scale = interpolate(frame, [0, 180], [zoom, zoom + 0.012], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <Img
      src={staticFile(src)}
      style={{
        height: "100%",
        objectFit: "cover",
        transform: `scale(${scale})`,
        width: "100%",
      }}
    />
  );
};

const Pointer: React.FC<{
  targetX: number;
  targetY: number;
  label: string;
  top?: number;
}> = ({ targetX, targetY, label, top = 580 }) => {
  const frame = useCurrentFrame();
  const progress = interpolate(frame, [14, 36], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const startX = 775;
  const startY = top + 30;
  const path = `M ${startX} ${startY} C 980 ${startY}, 1050 ${targetY}, ${targetX} ${targetY}`;

  return (
    <>
      <div
        style={{
          backgroundColor: "rgba(8,40,50,0.94)",
          border: `2px solid ${colors.border}`,
          borderRadius: 16,
          color: colors.text,
          fontFamily,
          fontSize: 22,
          fontWeight: 800,
          left: 500,
          letterSpacing: 0.3,
          opacity: progress,
          padding: "16px 22px",
          position: "absolute",
          top,
          zIndex: 5,
        }}
      >
        {label}
      </div>
      <svg
        height="1080"
        style={{ left: 0, position: "absolute", top: 0, zIndex: 4 }}
        viewBox="0 0 1920 1080"
        width="1920"
      >
        <defs>
          <marker
            id={`arrow-${label.replace(/\W/g, "")}`}
            markerHeight="10"
            markerWidth="10"
            orient="auto"
            refX="8"
            refY="5"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill={colors.yellow} />
          </marker>
        </defs>
        <path
          d={path}
          fill="none"
          markerEnd={`url(#arrow-${label.replace(/\W/g, "")})`}
          stroke={colors.yellow}
          strokeDasharray="700"
          strokeDashoffset={700 * (1 - progress)}
          strokeLinecap="round"
          strokeWidth="5"
        />
      </svg>
    </>
  );
};

const SceneBase: React.FC<{
  duration: number;
  children: React.ReactNode;
}> = ({ duration, children }) => (
  <SceneFade duration={duration}>
    <GridBackground />
    {children}
  </SceneFade>
);

const OverviewScene: React.FC = () => (
  <SceneBase duration={FINAL_SUBMISSION_SCENE_FRAMES.overview}>
    <SceneCopy
      eyebrow="myboon product demo"
      title={<>One app. One connected journey.</>}
      body={<>Move from market information to Solana execution without rebuilding the story across different apps.</>}
    />
    <PhoneShell>
      <PhoneVideo src={recordings.overview} trimBeforeSeconds={5.4} />
    </PhoneShell>
  </SceneBase>
);

const FeedScene: React.FC = () => {
  const videoFrames = secondsToFrames(5.5);
  const duration = FINAL_SUBMISSION_SCENE_FRAMES.feed;

  return (
    <SceneBase duration={duration}>
      <SceneCopy
        eyebrow="Feed"
        title={<>Your personal market analyst.</>}
        body={<>Developing stories stay at the top, while the latest researched updates keep the market current.</>}
      />
      <Sequence durationInFrames={videoFrames} layout="none">
        <PhoneShell>
          <PhoneVideo src={recordings.overview} trimBeforeSeconds={5.8} />
        </PhoneShell>
      </Sequence>
      <Sequence from={videoFrames} durationInFrames={duration - videoFrames} layout="none">
        <PhoneShell>
          <PhoneStill src={stills.feed} />
        </PhoneShell>
      </Sequence>
      <Pointer label="Developing stories + latest updates" targetX={1320} targetY={360} top={640} />
    </SceneBase>
  );
};

const CalendarScene: React.FC = () => {
  const videoFrames = secondsToFrames(4.2);
  const duration = FINAL_SUBMISSION_SCENE_FRAMES.calendar;

  return (
    <SceneBase duration={duration}>
      <SceneCopy
        eyebrow="Market calendar"
        title={<>See what happened—and what is coming.</>}
        body={<>Key market dates sit beside the feed, so upcoming catalysts do not arrive without context.</>}
      />
      <Sequence durationInFrames={videoFrames} layout="none">
        <PhoneShell>
          <PhoneVideo src={recordings.storyCalendar} trimBeforeSeconds={58.3} />
        </PhoneShell>
      </Sequence>
      <Sequence from={videoFrames} durationInFrames={duration - videoFrames} layout="none">
        <PhoneShell>
          <PhoneStill src={stills.calendar} />
        </PhoneShell>
      </Sequence>
      <Pointer label="Past events → upcoming catalysts" targetX={1390} targetY={520} top={650} />
    </SceneBase>
  );
};

const StoryScene: React.FC = () => {
  const openingFrames = secondsToFrames(5);
  const latestFreezeFrames = secondsToFrames(4);
  const timelineScrollFrames = secondsToFrames(3);
  const duration = FINAL_SUBMISSION_SCENE_FRAMES.story;

  return (
    <SceneBase duration={duration}>
      <SceneCopy
        eyebrow="Bitcoin story"
        title={<>One story, built over time.</>}
        body={<>The source, latest development, and chronological timeline stay connected—so the user is not acting on an isolated headline.</>}
      />
      <Sequence durationInFrames={openingFrames} layout="none">
        <PhoneShell>
          <PhoneVideo src={recordings.bitcoinPhoenix} trimBeforeSeconds={17} />
        </PhoneShell>
      </Sequence>
      <Sequence
        from={openingFrames}
        durationInFrames={latestFreezeFrames}
        layout="none"
      >
        <PhoneShell>
          <PhoneStill src={stills.bitcoinStory} />
        </PhoneShell>
      </Sequence>
      <Sequence
        from={openingFrames + latestFreezeFrames}
        durationInFrames={timelineScrollFrames}
        layout="none"
      >
        <PhoneShell>
          <PhoneVideo src={recordings.bitcoinPhoenix} trimBeforeSeconds={22} />
        </PhoneShell>
      </Sequence>
      <Sequence
        from={openingFrames + latestFreezeFrames + timelineScrollFrames}
        durationInFrames={
          duration - openingFrames - latestFreezeFrames - timelineScrollFrames
        }
        layout="none"
      >
        <PhoneShell>
          <PhoneStill src={stills.bitcoinTimeline} />
        </PhoneShell>
      </Sequence>
      <Pointer label="Latest development + chronological memory" targetX={1325} targetY={605} top={680} />
    </SceneBase>
  );
};

const HandoffScene: React.FC = () => {
  const actionFrames = secondsToFrames(2);
  const duration = FINAL_SUBMISSION_SCENE_FRAMES.handoff;

  return (
    <SceneBase duration={duration}>
      <SceneCopy
        eyebrow="Context to execution"
        title={<>Take action from the story.</>}
        body={<>The relevant market is available from the same screen, without a second search.</>}
      />
      <Sequence durationInFrames={actionFrames} layout="none">
        <PhoneShell>
          <PhoneVideo src={recordings.bitcoinPhoenix} trimBeforeSeconds={26} />
        </PhoneShell>
      </Sequence>
      <Sequence from={actionFrames} durationInFrames={duration - actionFrames} layout="none">
        <PhoneShell>
          <PhoneVideo src={recordings.bitcoinPhoenix} trimBeforeSeconds={30.6} />
        </PhoneShell>
      </Sequence>
      <Pointer label="Take Action → BTC perpetual market" targetX={1580} targetY={300} top={655} />
    </SceneBase>
  );
};

const ChartContextScene: React.FC = () => {
  const videoFrames = secondsToFrames(9);
  const duration = FINAL_SUBMISSION_SCENE_FRAMES.chartContext;

  return (
    <SceneBase duration={duration}>
      <SceneCopy
        eyebrow="Phoenix BTC-PERP"
        title={<>The context stays on the chart.</>}
        body={<>Market events appear beside the move they help explain, while the trading interface remains ready below.</>}
      />
      <Sequence durationInFrames={videoFrames} layout="none">
        <PhoneShell>
          <PhoneVideo src={recordings.bitcoinPhoenix} trimBeforeSeconds={31.2} />
        </PhoneShell>
      </Sequence>
      <Sequence from={videoFrames} durationInFrames={duration - videoFrames} layout="none">
        <PhoneShell>
          <PhoneStill src={stills.phoenixContext} />
        </PhoneShell>
      </Sequence>
      <Pointer label="Research markers stay beside price" targetX={1375} targetY={255} top={650} />
    </SceneBase>
  );
};

const TradeScene: React.FC = () => {
  const videoFrames = secondsToFrames(8);
  const duration = FINAL_SUBMISSION_SCENE_FRAMES.trade;

  return (
    <SceneBase duration={duration}>
      <SceneCopy
        eyebrow="Execute"
        title={<>Choose the trade without leaving myboon.</>}
        body={<>Direction, order type, size, and existing positions remain in one connected flow.</>}
      />
      <Sequence durationInFrames={videoFrames} layout="none">
        <PhoneShell>
          <PhoneVideo src={recordings.bitcoinPhoenix} trimBeforeSeconds={40} />
        </PhoneShell>
      </Sequence>
      <Sequence from={videoFrames} durationInFrames={duration - videoFrames} layout="none">
        <PhoneShell>
          <PhoneStill src={stills.tradeOrder} />
        </PhoneShell>
      </Sequence>
      <Pointer label="Order controls + positions" targetX={1330} targetY={715} top={660} />
    </SceneBase>
  );
};

const ActionCenterScene: React.FC = () => {
  const videoFrames = secondsToFrames(7);
  const duration = FINAL_SUBMISSION_SCENE_FRAMES.actionCenter;

  return (
    <SceneBase duration={duration}>
      <SceneCopy
        eyebrow="Solana action center"
        title={<>Use the venue that fits the opportunity.</>}
        body={<>Perpetuals, prediction markets, liquidity venues, spot discovery, and swaps are available from the same product.</>}
      />
      <Sequence durationInFrames={videoFrames} layout="none">
        <PhoneShell>
          <PhoneVideo src={recordings.actionCenter} trimBeforeSeconds={8} />
        </PhoneShell>
      </Sequence>
      <Sequence from={videoFrames} durationInFrames={duration - videoFrames} layout="none">
        <PhoneShell>
          <PhoneStill src={stills.marketGrid} />
        </PhoneShell>
      </Sequence>
      <Pointer label="Integrated Solana venues" targetX={1340} targetY={890} top={670} />
    </SceneBase>
  );
};

const WalletAndSwapScene: React.FC = () => {
  const walletFrames = secondsToFrames(5.5);
  const swapFrames = secondsToFrames(9);
  const duration = FINAL_SUBMISSION_SCENE_FRAMES.walletAndSwap;

  return (
    <SceneBase duration={duration}>
      <SceneCopy
        eyebrow="Wallet and swaps"
        title={<>The portfolio stays connected to the action.</>}
        body={<>See balances and positions together, then complete a token swap without leaving the app.</>}
      />
      <Sequence durationInFrames={walletFrames} layout="none">
        <PhoneShell>
          <PhoneVideo src={recordings.actionCenter} trimBeforeSeconds={46.5} />
        </PhoneShell>
      </Sequence>
      <Sequence from={walletFrames} durationInFrames={swapFrames} layout="none">
        <PhoneShell>
          <PhoneVideo src={recordings.actionCenter} trimBeforeSeconds={53.5} />
        </PhoneShell>
      </Sequence>
      <Sequence
        from={walletFrames + swapFrames}
        durationInFrames={duration - walletFrames - swapFrames}
        layout="none"
      >
        <PhoneShell>
          <PhoneStill src={stills.swapSuccess} />
        </PhoneShell>
      </Sequence>
      <Pointer label="Balances → quote → completed swap" targetX={1325} targetY={780} top={675} />
    </SceneBase>
  );
};

const EndingScene: React.FC = () => (
  <SceneBase duration={FINAL_SUBMISSION_SCENE_FRAMES.ending}>
    <SceneCopy
      eyebrow="myboon"
      title={<>Know why the market moved. Act in the same app.</>}
      body={<>One connected product for market context and Solana execution.</>}
    />
    <PhoneShell>
      <PhoneStill src={stills.feed} />
    </PhoneShell>
  </SceneBase>
);

export const FinalSubmissionScreens: React.FC = () => (
  <AbsoluteFill style={{ backgroundColor: colors.background, fontFamily }}>
    <Sequence
      from={FINAL_SUBMISSION_SCENE_STARTS.overview}
      durationInFrames={FINAL_SUBMISSION_SCENE_FRAMES.overview}
    >
      <OverviewScene />
    </Sequence>
    <Sequence
      from={FINAL_SUBMISSION_SCENE_STARTS.feed}
      durationInFrames={FINAL_SUBMISSION_SCENE_FRAMES.feed}
    >
      <FeedScene />
    </Sequence>
    <Sequence
      from={FINAL_SUBMISSION_SCENE_STARTS.calendar}
      durationInFrames={FINAL_SUBMISSION_SCENE_FRAMES.calendar}
    >
      <CalendarScene />
    </Sequence>
    <Sequence
      from={FINAL_SUBMISSION_SCENE_STARTS.story}
      durationInFrames={FINAL_SUBMISSION_SCENE_FRAMES.story}
    >
      <StoryScene />
    </Sequence>
    <Sequence
      from={FINAL_SUBMISSION_SCENE_STARTS.handoff}
      durationInFrames={FINAL_SUBMISSION_SCENE_FRAMES.handoff}
    >
      <HandoffScene />
    </Sequence>
    <Sequence
      from={FINAL_SUBMISSION_SCENE_STARTS.chartContext}
      durationInFrames={FINAL_SUBMISSION_SCENE_FRAMES.chartContext}
    >
      <ChartContextScene />
    </Sequence>
    <Sequence
      from={FINAL_SUBMISSION_SCENE_STARTS.trade}
      durationInFrames={FINAL_SUBMISSION_SCENE_FRAMES.trade}
    >
      <TradeScene />
    </Sequence>
    <Sequence
      from={FINAL_SUBMISSION_SCENE_STARTS.actionCenter}
      durationInFrames={FINAL_SUBMISSION_SCENE_FRAMES.actionCenter}
    >
      <ActionCenterScene />
    </Sequence>
    <Sequence
      from={FINAL_SUBMISSION_SCENE_STARTS.walletAndSwap}
      durationInFrames={FINAL_SUBMISSION_SCENE_FRAMES.walletAndSwap}
    >
      <WalletAndSwapScene />
    </Sequence>
    <Sequence
      from={FINAL_SUBMISSION_SCENE_STARTS.ending}
      durationInFrames={FINAL_SUBMISSION_SCENE_FRAMES.ending}
    >
      <EndingScene />
    </Sequence>
  </AbsoluteFill>
);
