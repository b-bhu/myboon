/**
 * #807: the Spot row's Swap button opens the Wallet root on Swap with the token
 * as the pay card. The param name `prefillMint` is read by HomeScreen.
 * A row with no mint opens nothing (same as Buy and Sell).
 */
export function spotSwapRoute(mint: string | null | undefined): { pathname: '/'; params: { prefillMint: string } } | null {
  return mint ? { pathname: '/', params: { prefillMint: mint } } : null;
}
