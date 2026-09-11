export const FINAL_SUBMISSION_FPS = 30;

export const FINAL_SUBMISSION_SCENE_FRAMES = {
  overview: 8 * FINAL_SUBMISSION_FPS,
  feed: 12 * FINAL_SUBMISSION_FPS,
  calendar: 10 * FINAL_SUBMISSION_FPS,
  story: 18 * FINAL_SUBMISSION_FPS,
  handoff: 10 * FINAL_SUBMISSION_FPS,
  chartContext: 14 * FINAL_SUBMISSION_FPS,
  trade: 10 * FINAL_SUBMISSION_FPS,
  actionCenter: 14 * FINAL_SUBMISSION_FPS,
  walletAndSwap: 18 * FINAL_SUBMISSION_FPS,
  ending: 7 * FINAL_SUBMISSION_FPS,
} as const;

export const FINAL_SUBMISSION_SCENE_STARTS = {
  overview: 0,
  feed: 8 * FINAL_SUBMISSION_FPS,
  calendar: 20 * FINAL_SUBMISSION_FPS,
  story: 30 * FINAL_SUBMISSION_FPS,
  handoff: 48 * FINAL_SUBMISSION_FPS,
  chartContext: 58 * FINAL_SUBMISSION_FPS,
  trade: 72 * FINAL_SUBMISSION_FPS,
  actionCenter: 82 * FINAL_SUBMISSION_FPS,
  walletAndSwap: 96 * FINAL_SUBMISSION_FPS,
  ending: 114 * FINAL_SUBMISSION_FPS,
} as const;

export const FINAL_SUBMISSION_TOTAL_FRAMES = 121 * FINAL_SUBMISSION_FPS;

export const FINAL_ETERNAL_DEMO_TOTAL_FRAMES = 4234;

export const FINAL_ETERNAL_PITCH_TOTAL_FRAMES = 2789;

export const secondsToFrames = (seconds: number) =>
  Math.round(seconds * FINAL_SUBMISSION_FPS);
