import { tokens } from '@/theme/tokens';

export const semantic = {
  background: {
    screen: tokens.colors.backgroundDark,
    surface: tokens.colors.ground,
    surfaceRaised: tokens.colors.surface,
    lift: tokens.colors.lift,
    header: `rgba(7, 59, 76, ${tokens.opacity.headerBackground})`,
    nav: `rgba(4, 31, 42, ${tokens.opacity.navBackground})`,
    topCardOverlay: `rgba(17, 138, 178, ${tokens.opacity.topCardOverlay})`,
    liveDotOuter: `rgba(6, 214, 160, ${tokens.opacity.liveDotOuter})`,
  },
  border: {
    muted: tokens.colors.borderMuted,
    nav: `rgba(255, 209, 102, ${tokens.opacity.navBorder})`,
    imageSoft: `rgba(245, 250, 252, ${tokens.opacity.borderSoft})`,
  },
  text: {
    primary: tokens.colors.bone,
    dim: tokens.colors.textDim,
    faint: tokens.colors.textFaint,
    accent: tokens.colors.primary,
    accentDim: tokens.colors.primaryDim,
    categoryMeta: `rgba(245, 250, 252, ${tokens.opacity.categoryMeta})`,
  },
  sentiment: {
    positive: tokens.colors.viridian,
    negative: tokens.colors.vermillion,
  },
  polymarket: {
    cardFeatured: 'rgba(17, 138, 178, 0.2)',
    rowBorderSoft: 'rgba(245, 250, 252, 0.1)',
    badgeGeoBg: 'rgba(255, 209, 102, 0.1)',
    badgeSportBg: 'rgba(6, 214, 160, 0.1)',
    outcomeYesBg: 'rgba(6, 214, 160, 0.12)',
    outcomeYesBorder: 'rgba(6, 214, 160, 0.3)',
    outcomeNoBg: 'rgba(239, 71, 111, 0.12)',
    outcomeNoBorder: 'rgba(239, 71, 111, 0.3)',
    outcomeDrawBg: 'rgba(255, 209, 102, 0.12)',
    outcomeDrawBorder: 'rgba(255, 209, 102, 0.28)',
  },
} as const;

export type SemanticTheme = typeof semantic;
