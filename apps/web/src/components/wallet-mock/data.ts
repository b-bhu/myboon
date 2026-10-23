// Example data, ported as-is from the approved mock (/workspace/bounty/move/data.js).
// Balances are illustrative.
export type Group = 'app' | 'chain'
export type Endpoint = { k: string; n: string; b: number; g: Group; ch: string }
export type Token = 'USDC' | 'USDT' | 'SOL' | 'ETH'

const SVG = ['polymarket', 'phoenix', 'meteora', 'solana', 'base', 'ethereum', 'robinhood']
const PNG = ['pacifica', 'drift', 'kamino', 'jupiter', 'hyperliquid', 'marginfi', 'aave', 'morpho', 'limitless', 'arbitrum', 'polygon', 'optimism', 'bnb', 'avalanche', 'hyperevm']
// Every logo is served locally from /wallet-mock/ (sources listed in #435).
export const LOGO: Record<string, string> = Object.fromEntries([...SVG.map((k) => [k, `/wallet-mock/${k}.svg`]), ...PNG.map((k) => [k, `/wallet-mock/${k}.png`])])
export const COL: Record<string, string> = { polymarket: '#7FA8FF', phoenix: '#FF8D2A', pacifica: '#61D7EF', solana: '#B98AFF', base: '#5B8CFF', ethereum: '#C9D2FF', robinhood: '#CCFF00' }

const APPS: [string, string, number, string][] = [['polymarket', 'Polymarket', 412.5, 'Polygon'], ['phoenix', 'Phoenix', 350, 'Solana'], ['pacifica', 'Pacifica', 200, 'Solana'], ['meteora', 'Meteora', 0, 'Solana'], ['drift', 'Drift', 0, 'Solana'], ['kamino', 'Kamino', 0, 'Solana'], ['jupiter', 'Jupiter', 0, 'Solana'], ['hyperliquid', 'Hyperliquid', 0, 'HyperEVM'], ['marginfi', 'marginfi', 0, 'Solana'], ['aave', 'Aave', 0, 'Base'], ['morpho', 'Morpho', 0, 'Base'], ['limitless', 'Limitless', 0, 'Base']]
const CHAINS: [string, string, number][] = [['solana', 'Solana', 4743.6], ['base', 'Base', 58.2], ['ethereum', 'Ethereum', 0], ['robinhood', 'Robinhood Chain', 0], ['arbitrum', 'Arbitrum', 0], ['polygon', 'Polygon', 0], ['optimism', 'Optimism', 0], ['hyperevm', 'HyperEVM', 0], ['bnb', 'BNB Chain', 0], ['avalanche', 'Avalanche', 0]]

export const ALL: Endpoint[] = [
  ...APPS.map(([k, n, b, ch]) => ({ k, n, b, g: 'app' as const, ch })),
  ...CHAINS.map(([k, n, b]) => ({ k, n, b, g: 'chain' as const, ch: n })),
]
export const BY: Record<string, Endpoint> = Object.fromEntries(ALL.map((x) => [x.k, x]))

// Tokens each endpoint accepts (example). First is the default.
const TOKS: Record<string, Token[]> = { solana: ['USDC', 'SOL'], base: ['USDC', 'ETH'], ethereum: ['USDC', 'ETH'], robinhood: ['USDC', 'ETH'], arbitrum: ['USDC', 'ETH'], optimism: ['USDC', 'ETH'], polymarket: ['USDC'], phoenix: ['USDC', 'SOL'], pacifica: ['USDC'] }
export const toks = (k: string): Token[] => TOKS[k] || ['USDC']
const TBAL: Record<string, Partial<Record<Token, number>>> = { solana: { SOL: 12.4 }, base: { ETH: 0.04 }, phoenix: { SOL: 2.1 } }
export const bal = (k: string, t: Token) => (t === 'USDC' ? BY[k].b : TBAL[k]?.[t] || 0)
export const hasBal = (k: string) => toks(k).some((t) => bal(k, t) > 0)
export const PX: Record<Token, number> = { USDC: 1, USDT: 1, SOL: 180, ETH: 3200 }
export const TCOL: Record<Token, string> = { USDC: '#5B9BFF', USDT: '#26C59A', SOL: '#B98AFF', ETH: '#C9D2FF' }
export const TGL: Record<Token, string> = { USDC: '$', USDT: '₮', SOL: '◎', ETH: 'Ξ' }
export const dec = (t: Token) => (PX[t] > 10 ? 4 : 2)
export const fT = (n: number, t: Token) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: dec(t) })
export const f2 = (n: number) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
