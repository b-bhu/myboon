/**
 * Routes used by the feed's Take Action cards.
 *
 * Keep this mapping pure so the story-to-market contract can be verified
 * without importing React Native or Expo Router.
 */

export type PhoenixActionRoute =
  | '/markets/phoenix'
  | {
      pathname: '/markets/phoenix/[symbol]';
      params: {
        symbol: 'BTC-PERP';
      };
    };

/**
 * Bitcoin stories open the BTC-PERP detail route. Every other story keeps the
 * generic venue route used by the rest of the feed.
 */
export function getPhoenixActionRoute(storySlug?: string): PhoenixActionRoute {
  const normalizedSlug = storySlug?.trim().toLowerCase();
  if (normalizedSlug === 'bitcoin') {
    return {
      pathname: '/markets/phoenix/[symbol]',
      params: {
        symbol: 'BTC-PERP',
      },
    };
  }

  return '/markets/phoenix';
}
