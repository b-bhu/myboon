import { FEED_TOKENS } from './feed-tokens';

/**
 * The one Feed palette (issue #797). `FEED_TOKENS` (feed-tokens.ts) owns every
 * colour the theme defines, so its values can no longer disagree with these:
 * `screen` is #031F2C everywhere (Home and All updates), and border/text/accent
 * come straight from the tokens. The remaining fills have no matching theme
 * token and keep their hex here, the `backdrop` pattern in feed-tokens.ts.
 */
export const FEED_COLORS = {
  screen: FEED_TOKENS.colors.screen,
  card: '#033744',
  cardActive: '#053F4D',
  cardDeep: '#082D39',
  border: FEED_TOKENS.colors.border,
  borderSoft: '#2C6170',
  text: FEED_TOKENS.colors.text,
  textDim: FEED_TOKENS.colors.textDim,
  textFaint: FEED_TOKENS.colors.textFaint,
  accent: FEED_TOKENS.colors.accent,
} as const;
