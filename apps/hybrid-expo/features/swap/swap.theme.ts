import { tokens } from '@/theme';

// This palette belongs to Wallet's inline trade surface, not Feed or Apps.
export const swapTheme = {
  gold: tokens.colors.primaryDim,
  navy: tokens.colors.walletCore,
  card: tokens.colors.surface,
  text: tokens.colors.bone,
  dim: tokens.colors.textDim,
  border: tokens.colors.borderMuted,
  error: tokens.colors.vermillion,
  positive: tokens.colors.viridian,
  composerInset: 14,
  composerRadius: 14,
  panelOverlap: 24,
} as const;
