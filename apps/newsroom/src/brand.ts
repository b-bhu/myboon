// MyBoon News brand kit. LOCKED. Source of truth: apps/web/src/lib/tokens.ts
// (mirrors apps/hybrid-expo/theme/tokens.ts; no conflicts as of 2026-11-01).
// Assets live in locked/, exposed to Remotion via public/locked -> ../locked.
import { continueRender, delayRender, staticFile } from "remotion";

export const colors = {
  primary: "#118AB2",
  primaryDim: "#FFD166",
  backgroundDark: "#073B4C",
  walletCore: "#031F2C",
  ground: "#063343",
  surface: "#083D50",
  lift: "#0A4A60",
  borderMuted: "#185A70",
  bone: "#F5FAFC",
  textDim: "#9CB8C2",
  textFaint: "#6B95A1",
  viridian: "#06D6A0",
  vermillion: "#EF476F",
  positive: "#06D6A0",
  live: "#EF476F",
  accent: "#FFD166",
} as const;
export type ColorToken = keyof typeof colors;

/** Price ticker semantics: up = positive (viridian), down = live (vermillion). */
export const ticker = { up: colors.positive, down: colors.live, flat: colors.textDim } as const;

export const walletBrand = {
  solana: "#9945FF",
  meteora: "#6E45FF",
  phoenix: "#FF8D2A",
  pacifica: "#61D7EF",
} as const;

export const radius = { xs: 2, sm: 4, md: 6, full: 999 } as const;
export const spacing = { xxs: 2, xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;
export const letterSpacing = { tight: -0.3, tighter: -0.2, nav: -0.1, mono: 1, monoWide: 1.2 } as const;

/** Same roles as the web app: headline / body / mono. */
export const fonts = {
  headline: '"Space Grotesk", system-ui, sans-serif',
  body: '"Inter", system-ui, sans-serif',
  mono: '"Geist Mono", ui-monospace, monospace',
} as const;

const fontFiles: { family: string; weight: string; file: string }[] = [
  ...["300", "400", "500", "700"].map((w) => ({ family: "Space Grotesk", weight: w, file: `space-grotesk-latin-${w}-normal.woff2` })),
  ...["400", "500", "600"].map((w) => ({ family: "Inter", weight: w, file: `inter-latin-${w}-normal.woff2` })),
  ...["400", "500"].map((w) => ({ family: "Geist Mono", weight: w, file: `geist-mono-latin-${w}-normal.woff2` })),
];

let loaded = false;
/** Call once at module level of any composition that uses brand fonts. */
export const loadBrandFonts = () => {
  if (loaded || typeof document === "undefined") return;
  loaded = true;
  // Fire-and-forget. Do NOT delayRender on FontFace — OffthreadVideo-heavy
  // episodes can starve the main thread so face.load() never settles, and a
  // setTimeout race deadlocks because Remotion freezes timers while delayed.
  Promise.all(
    fontFiles.map(async ({ family, weight, file }) => {
      const face = new FontFace(family, `url(${staticFile(`locked/fonts/${file}`)}) format("woff2")`, { weight });
      await face.load();
      document.fonts.add(face);
    }),
  ).catch((err) => console.warn("brand fonts load failed", err));
};

export const logos = {
  /** Raster wordmark used in the app header (420x218, transparent). Preferred for broadcast. */
  wordmark: staticFile("locked/chrome/myboon-wordmark-header.png"),
  wordmarkSmall: staticFile("locked/chrome/myboon-wordmark-small@2x.png"),
  /** SVG icons use <text> in Avenir Next (not outlined); renders with fallback fonts on Linux. */
  icon: staticFile("locked/chrome/myboon-app-icon-v2.svg"),
  iconForeground: staticFile("locked/chrome/myboon-app-icon-foreground-v2.svg"),
  iconMono: staticFile("locked/chrome/myboon-app-icon-monochrome-v2.svg"),
  favicon: staticFile("locked/chrome/myboon-favicon.svg"),
} as const;
