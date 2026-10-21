// Web mirror of apps/hybrid-expo/theme/tokens.ts `colors`.
// Keep in sync with the app; the landing page uses only these values.
export const colors = {
  primary: '#118AB2',
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
  accent: '#FFD166',
} as const

export type ColorToken = keyof typeof colors

/** CSS custom properties (`--c-<token>`) for every colour token. */
export const colorVars = Object.fromEntries(
  Object.entries(colors).map(([k, v]) => [`--c-${k}`, v]),
) as Record<string, string>
