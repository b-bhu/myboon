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

/**
 * Trade targets for a token sheet (issue #500): Swap is always first and buys
 * the token from the feed; the Phoenix perps route appears only for the
 * exact symbols SOL, BTC and ETH (case-insensitive, no derivatives like WSOL).
 * Keep this mapping pure so it can be verified without React Native.
 */
export type TokenTradeRoute = {
  label: 'Swap' | 'Perps';
  route:
    | { pathname: '/swap'; params: { mode: 'buy'; token: string; caller: 'feed' } }
    | { pathname: '/markets/phoenix/[symbol]'; params: { symbol: string } };
};

const PERPS_SYMBOLS = new Set(['sol', 'btc', 'eth']);

export function tokenTradeRoutes(token: { address: string; symbol: string }): TokenTradeRoute[] {
  const symbol = token.symbol.toLowerCase();
  const routes: TokenTradeRoute[] = [
    {
      label: 'Swap',
      route: { pathname: '/swap', params: { mode: 'buy', token: token.address, caller: 'feed' } },
    },
  ];
  if (PERPS_SYMBOLS.has(symbol)) {
    routes.push({
      label: 'Perps',
      route: { pathname: '/markets/phoenix/[symbol]', params: { symbol: `${symbol.toUpperCase()}-PERP` } },
    });
  }
  return routes;
}
