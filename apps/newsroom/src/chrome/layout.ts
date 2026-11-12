// Locked overlay layout, 1920x1080. All overlays share these numbers.
export const layout = {
  margin: 64,            // safe margin left/right/top
  tickerHeight: 60,      // bottom strip, y = 1020..1080
  tickerSpeed: 120,      // px per second, right to left, constant
  slotGap: 24,           // gap between ticker top and lower third / BREAKING bar
  logoHeight: 56,
  inFrames: 9,           // ~0.3 s at 30 fps
} as const;
export const slotBottom = layout.tickerHeight + layout.slotGap; // px from frame bottom

/** OVER VISUAL safe area (1920x1080): clears the logo bug (bottom ~138 px) and the
 *  lower-third/BREAKING slot above the ticker (top ~ y=880). Assets are fitted inside this box. */
export const overVisualSafe = { x: 160, y: 160, width: 1600, height: 720 } as const;
