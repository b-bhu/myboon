export const tokens = {
  colors: {
    primary: '#118AB2',
    primaryDim: '#FFD166',
    backgroundDark: '#073B4C',
    walletCore: '#031F2C',
    ground: '#063343',
    surface: '#083D50',
    lift: '#0A4A60',
    borderMuted: '#185A70',
    bone: '#F5FAFC',
    textDim: '#9CB8C2',
    textFaint: '#6B95A1',
    viridian: '#06D6A0',
    vermillion: '#EF476F',
    positive: '#06D6A0',
    live: '#EF476F',
    accent: '#FFD166',
  },
  // Real per-protocol brand colors for Wallet account rows (PRD design decision #15).
  // Spot uses Solana's own purple; Meteora uses the violet end of its real gradient
  // mark (kept distinct from Phoenix's orange); Phoenix/Pacifica are their actual
  // flat brand-mark fills (see features/home/marketBrandAssets.ts).
  walletBrand: {
    spot: '#9945FF',
    meteora: '#6E45FF',
    phoenix: '#FF8D2A',
    pacifica: '#61D7EF',
  },
  spacing: {
    xxs: 2,
    xs: 4,
    sm: 8,
    md: 12,
    lg: 16,
    xl: 24,
  },
  radius: {
    xs: 2,
    sm: 4,
    md: 6,
    full: 999,
  },
  fontSize: {
    xxs: 9,
    xs: 10,
    sm: 12,
    md: 14,
    lg: 24,
    xl: 38,
  },
  lineHeight: {
    percent: 38,
    title: 27,
    body: 20,
  },
  letterSpacing: {
    tight: -0.3,
    tighter: -0.2,
    nav: -0.1,
    mono: 1,
    monoWide: 1.2,
  },
  sizing: {
    headerLogoWidth: 86,
    headerLogoHeight: 45,
    percentColumnWidth: 52,
    navIcon: 22,
  },
  opacity: {
    muted: 0.6,
    topCardOverlay: 0.04,
    categoryMeta: 0.62,
    liveDotOuter: 0.35,
    navBorder: 0.1,
    navBackground: 0.7,
    borderSoft: 0.6,
    headerBackground: 0.92,
  },
  shadow: {
    card: {
      shadowColor: '#000',
      shadowOpacity: 0.22,
      shadowRadius: 12,
      shadowOffset: { width: 0, height: 6 },
      elevation: 8,
    },
    nav: {
      shadowColor: '#000',
      shadowOpacity: 0.35,
      shadowRadius: 20,
      shadowOffset: { width: 0, height: 8 },
      elevation: 9,
    },
  },
} as const;

export type AppTokens = typeof tokens;
