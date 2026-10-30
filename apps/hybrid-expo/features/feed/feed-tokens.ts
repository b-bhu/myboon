import { tokens } from '../../theme/tokens';

export type FeedBoxTone = 'ground' | 'card' | 'lift';

export type FeedTokenColorKey =
  | 'screen'
  | 'card'
  | 'ground'
  | 'lift'
  | 'border'
  | 'text'
  | 'textDim'
  | 'textFaint'
  | 'accent'
  | 'up'
  | 'down'
  | 'backdrop';

export type FeedTokenTypeKey =
  | 'big'
  | 'title'
  | 'section'
  | 'cardTitle'
  | 'body'
  | 'secondary'
  | 'caption'
  | 'label';

export type FeedTokenSpaceKey = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | 'xxl';

export type FeedTokenRadiusKey = 'chip' | 'button' | 'card' | 'sheet';

export type FeedTokens = {
  colors: Record<FeedTokenColorKey, string>;
  type: Record<FeedTokenTypeKey, number>;
  space: Record<FeedTokenSpaceKey, number>;
  radius: Record<FeedTokenRadiusKey, number>;
};

/**
 * Design token values for the Feed redesign prototype.
 *
 * See docs/mockups/design-language/DESIGN.md: colors only come from
 * apps/hybrid-expo/theme/tokens.ts where a matching token exists, the type
 * scale is exactly 34/28/20/18/15/14/12/11, spacing steps are only
 * 4/8/12/16/24/32 and there are no shadows anywhere.
 *
 * This module is deliberately react-free: it holds pure data so plain-node
 * tooling (including the prototype test harness) can require it directly.
 * feed-design.ts re-exports it and adds React-facing helpers.
 */
export const FEED_TOKENS: FeedTokens = {
  colors: {
    // Feed screen background (walletCore).
    screen: tokens.colors.walletCore,
    // Story cards.
    card: tokens.colors.backgroundDark,
    // Glance/calendar cards.
    ground: tokens.colors.ground,
    // Lifted fills (segmented tabs, icon tiles).
    lift: tokens.colors.lift,
    // Hairline borders.
    border: tokens.colors.borderMuted,
    text: tokens.colors.bone,
    textDim: tokens.colors.textDim,
    textFaint: tokens.colors.textFaint,
    // Gold accent, restrained to small action links.
    accent: tokens.colors.accent,
    // Meaning colours: up/positive, down/negative. Never decoration.
    up: tokens.colors.viridian,
    down: tokens.colors.vermillion,
    // Dim layer behind the bottom sheet; no token matches, prototype-only.
    backdrop: '#021821',
  },
  type: {
    big: 34,
    title: 28,
    section: 20,
    cardTitle: 18,
    body: 15,
    secondary: 14,
    caption: 12,
    label: 11,
  },
  space: {
    xs: tokens.spacing.xs,
    sm: tokens.spacing.sm,
    md: tokens.spacing.md,
    lg: tokens.spacing.lg,
    xl: tokens.spacing.xl,
    // Largest step of the scale; no spacing token matches.
    xxl: 32,
  },
  radius: {
    chip: tokens.radius.sm,
    button: tokens.radius.md,
    // Card and sheet top corners have no matching tokens.
    card: 8,
    sheet: 12,
  },
};