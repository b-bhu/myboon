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
 * Trade targets for a token sheet (issue #500, #655): Swap is always first and
 * buys the token from the feed; Spot deep-links the Jupiter terminal with the
 * canonical mint and appears only for mint-shaped addresses so the link never
 * dead-ends; the Phoenix perps route appears only for the exact symbols SOL,
 * BTC and ETH (case-insensitive, no derivatives like WSOL). Keep this mapping
 * pure so it can be verified without React Native.
 */
export type TokenTradeRoute = {
  label: 'Swap' | 'Spot' | 'Perps';
  route:
    | { pathname: '/swap'; params: { mode: 'buy'; token: string; caller: 'feed' } }
    | { pathname: '/spot'; params: { token: string } }
    | { pathname: '/markets/phoenix/[symbol]'; params: { symbol: string } };
};

const PERPS_SYMBOLS = new Set(['sol', 'btc', 'eth']);

/** Canonical Solana mint shape; SpotScreen.tsx:17 gates its `token` param on the same pattern. */
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function tokenTradeRoutes(token: { address: string; symbol: string }): TokenTradeRoute[] {
  const symbol = token.symbol.toLowerCase();
  const routes: TokenTradeRoute[] = [
    {
      label: 'Swap',
      route: { pathname: '/swap', params: { mode: 'buy', token: token.address, caller: 'feed' } },
    },
  ];
  // /spot preselection (issue #655) takes a mint, never a symbol; a non-mint
  // address would only land on "Linked token could not be resolved.", so the
  // surface stays on Swap rather than dead-ending.
  if (MINT_RE.test(token.address)) {
    routes.push({
      label: 'Spot',
      route: { pathname: '/spot', params: { token: token.address } },
    });
  }
  if (PERPS_SYMBOLS.has(symbol)) {
    routes.push({
      label: 'Perps',
      route: { pathname: '/markets/phoenix/[symbol]', params: { symbol: `${symbol.toUpperCase()}-PERP` } },
    });
  }
  return routes;
}
