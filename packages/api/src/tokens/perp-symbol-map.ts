// Checked-in perp venue symbol -> token identity assetId map.
//
// This is the union of every symbol listed by Pacifica and Phoenix as of
// 2026-08-11 (102 symbols). Perp identity resolution goes through this map
// ONLY — never fuzzy search. A ticker collision on a mid-cap would show a
// confidently wrong logo, which is worse than the letter-box fallback.
//
// The union is frozen. Do not add members without re-verifying the live
// symbol lists on both venues.

export const PERP_SYMBOL_TO_ASSET_ID: Record<string, string> = {
  '2Z': '2z',
  AAPL: 'aapl',
  AAVE: 'aave',
  ADA: 'ada',
  AMAT: 'amat',
  AMD: 'amd',
  AMZN: 'amzn',
  ANSEM: 'ansem',
  ARB: 'arb',
  ARM: 'arm',
  ASML: 'asml',
  ASTER: 'aster',
  AVAX: 'avax',
  BCH: 'bch',
  BNB: 'bnb',
  BP: 'bp',
  BTC: 'btc',
  CBRS: 'cbrs',
  CHIP: 'chip',
  CL: 'cl',
  COIN: 'coin',
  COPPER: 'copper',
  CRCL: 'crcl',
  CRV: 'crv',
  CRWV: 'crwv',
  DOGE: 'doge',
  DRAM: 'dram',
  ENA: 'ena',
  ETH: 'eth',
  EURUSD: 'eurusd',
  FARTCOIN: 'fartcoin',
  FET: 'fet',
  GOLD: 'gold',
  GOOGL: 'googl',
  HOOD: 'hood',
  HYPE: 'hype',
  ICP: 'icp',
  INTC: 'intc',
  JTO: 'jto',
  JUP: 'jup',
  KAITO: 'kaito',
  kBONK: 'bonk',
  kPEPE: 'pepe',
  kSHIB: 'shib',
  LDO: 'ldo',
  LINK: 'link',
  LIT: 'lit',
  LTC: 'ltc',
  MEGA: 'mega',
  MET: 'met',
  META: 'meta',
  MON: 'mon',
  MORPHO: 'morpho',
  MSFT: 'msft',
  MSTR: 'mstr',
  MU: 'mu',
  NATGAS: 'natgas',
  NBIS: 'nbis',
  NEAR: 'near',
  NVDA: 'nvda',
  ONDO: 'ondo',
  PAXG: 'paxg',
  PENGU: 'pengu',
  PIPPIN: 'pippin',
  PLATINUM: 'platinum',
  PLTR: 'pltr',
  PUMP: 'pump',
  QCOM: 'qcom',
  RENDER: 'render',
  SAMSUNG: 'samsung',
  SILVER: 'silver',
  SKHY: 'skhy',
  SKHYNIX: 'skhynix',
  SKR: 'skr',
  SNDK: 'sndk',
  SOL: 'sol',
  SP500: 'sp500',
  SPCX: 'spcx',
  STRK: 'strk',
  SUI: 'sui',
  TAO: 'tao',
  TRUMP: 'trump',
  TRX: 'trx',
  TSLA: 'tesla-stock',
  UNI: 'uni',
  URNM: 'urnm',
  USDJPY: 'usdjpy',
  VIRTUAL: 'virtual',
  VVV: 'vvv',
  WIF: 'wif',
  WLD: 'wld',
  WLFI: 'wlfi',
  WTIOIL: 'wtioil',
  XAG: 'xag',
  XAU: 'xau',
  XLM: 'xlm',
  XMR: 'xmr',
  XPL: 'xpl',
  XRP: 'xrp',
  ZEC: 'zec',
  ZK: 'zk',
  ZRO: 'zro',
}

// Case-insensitive lookup index, built once at module load.
const UPPER_TO_ASSET_ID: Record<string, string> = Object.fromEntries(
  Object.entries(PERP_SYMBOL_TO_ASSET_ID).map(([symbol, assetId]) => [symbol.toUpperCase(), assetId]),
)

/**
 * Resolve a venue perp symbol (with or without a trailing "-PERP") to its
 * token identity assetId. Exact map lookup only, case-insensitive on the
 * base symbol. Returns null when the symbol is not in the frozen union —
 * callers fall through to the static/letterbox fallback, never fuzzy search.
 */
export function perpAssetId(symbolOrAppSymbol: string): string | null {
  const stripped = symbolOrAppSymbol.replace(/-PERP$/i, '')
  return UPPER_TO_ASSET_ID[stripped.toUpperCase()] ?? null
}
