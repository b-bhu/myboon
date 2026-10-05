import { semantic } from '@/theme/semantic';
import { tokens } from '@/theme/tokens';

/** Shared MyBoon colors for every Meteora surface. No React Native imports. */
export const METEORA_COLORS = {
  screen: semantic.background.screen,
  surface: semantic.background.surface,
  surfaceRaised: semantic.background.surfaceRaised,
  surfaceLift: semantic.background.lift,
  surfaceQuiet: tokens.colors.walletCore,
  border: semantic.border.muted,
  text: semantic.text.primary,
  textDim: semantic.text.dim,
  textFaint: semantic.text.faint,
  primary: tokens.colors.primary,
  accent: tokens.colors.accent,
  onAccent: tokens.colors.walletCore,
  positive: semantic.sentiment.positive,
  negative: semantic.sentiment.negative,
  warning: tokens.colors.accent,
  tokenX: tokens.colors.textDim,
  tokenY: tokens.colors.accent,
} as const;

function translucent(color: string, opacity: number): string {
  const value = Number.parseInt(color.slice(1), 16);
  return `rgba(${value >> 16}, ${(value >> 8) & 255}, ${value & 255}, ${opacity})`;
}

export const METEORA_TINTS = {
  backdrop: translucent(tokens.colors.walletCore, 0.78),
  selected: translucent(tokens.colors.primary, 0.18),
  selectedBorder: translucent(tokens.colors.primary, 0.55),
  pressed: translucent(tokens.colors.primary, 0.08),
  positive: translucent(semantic.sentiment.positive, 0.1),
  positiveBorder: translucent(semantic.sentiment.positive, 0.34),
  negative: translucent(semantic.sentiment.negative, 0.08),
  negativeBorder: translucent(semantic.sentiment.negative, 0.34),
  warning: translucent(tokens.colors.accent, 0.1),
  warningBorder: translucent(tokens.colors.accent, 0.34),
  info: translucent(tokens.colors.primary, 0.08),
  infoBorder: translucent(tokens.colors.primary, 0.34),
} as const;
