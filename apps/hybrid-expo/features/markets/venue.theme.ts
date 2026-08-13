/**
 * Default `MarketListTheme` for venues that don't bring their own palette
 * (Meteora keeps its own via `adapter.theme` per PRD decision — venue
 * colour is wayfinding). Built from theme/tokens.ts + theme/semantic.ts,
 * the app's styling source of truth.
 *
 * PURE — theme/tokens.ts and theme/semantic.ts have no react-native
 * imports (verified), so this file stays react-native-free too.
 */

import { semantic } from '@/theme/semantic';
import { tokens } from '@/theme/tokens';

import type { MarketListTheme } from '@/features/markets/venue.contract';

export const DEFAULT_MARKET_LIST_THEME: MarketListTheme = {
  screen: semantic.background.screen,
  surface: semantic.background.surface,
  surfaceLift: semantic.background.lift,
  border: semantic.border.muted,
  rowDivider: semantic.border.muted,
  rowPressed: semantic.background.lift,
  text: semantic.text.primary,
  textDim: semantic.text.dim,
  textFaint: semantic.text.faint,
  accent: tokens.colors.accent,
  pos: semantic.sentiment.positive,
  neg: semantic.sentiment.negative,
};
