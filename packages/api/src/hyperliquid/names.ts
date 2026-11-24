/**
 * Display names for the Hyperliquid markets surfaced on story cards (#691).
 * `displaySymbol` is the chip text, `displayName` the long name; anything not
 * in the map falls back to the symbol without its `xyz:` prefix.
 */

/** Chip-text overrides for symbols whose bare name is not the chip. */
const SYMBOL_OVERRIDES: Record<string, string> = {
  'xyz:CL': 'WTI',
  'xyz:BRENTOIL': 'BRENT',
  'xyz:SP500': 'SPX',
}

const NAMES: Record<string, string> = {
  BTC: 'Bitcoin',
  ETH: 'Ethereum',
  SOL: 'Solana',
  XRP: 'XRP',
  BNB: 'BNB',
  HYPE: 'Hyperliquid',
  DOGE: 'Dogecoin',
  'xyz:CL': 'WTI crude oil',
  'xyz:BRENTOIL': 'Brent crude oil',
  'xyz:NATGAS': 'Natural gas',
  'xyz:GOLD': 'Gold',
  'xyz:SILVER': 'Silver',
  'xyz:COPPER': 'Copper',
  'xyz:SP500': 'S&P 500',
  'xyz:DXY': 'US dollar index',
  'xyz:VIX': 'VIX',
  'xyz:JPY': 'Japanese yen',
  'xyz:EUR': 'Euro',
  'xyz:TLT': 'US 20Y+ Treasuries',
  'xyz:GOOGL': 'Alphabet',
  'xyz:COIN': 'Coinbase',
  'xyz:NVDA': 'Nvidia',
  'xyz:TSLA': 'Tesla',
  'xyz:AAPL': 'Apple',
  'xyz:MSFT': 'Microsoft',
  'xyz:AMZN': 'Amazon',
  'xyz:META': 'Meta',
  'xyz:MSTR': 'Strategy',
  'xyz:CRCL': 'Circle',
  'xyz:HOOD': 'Robinhood',
}

/** Chip text for a Hyperliquid symbol: the symbol without its `xyz:` prefix, except the overrides. */
export function hyperliquidDisplaySymbol(symbol: string): string {
  return SYMBOL_OVERRIDES[symbol] ?? symbol.replace(/^xyz:/, '')
}

/** Long name for a Hyperliquid symbol; unknown symbols fall back to the chip text. */
export function hyperliquidDisplayName(symbol: string): string {
  return NAMES[symbol] ?? hyperliquidDisplaySymbol(symbol)
}
