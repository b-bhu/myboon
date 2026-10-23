import { BY, COL, LOGO, TCOL, TGL, type Token } from './data'

const P = {
  down: <path d="m6 9 6 6 6-6" />, right: <path d="m9 6 6 6-6 6" />, close: <path d="m6 6 12 12M18 6 6 18" />,
  bell: <path d="M6 16h12l-2-3V9a4 4 0 0 0-8 0v4zM10 20h4" />,
  feed: <><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M8 8h8M8 12h8M8 16h4" /></>,
  apps: <><rect x="4" y="4" width="6" height="6" rx="1" /><rect x="14" y="4" width="6" height="6" rx="1" /><rect x="4" y="14" width="6" height="6" rx="1" /><rect x="14" y="14" width="6" height="6" rx="1" /></>,
  wallet: <><path d="M4 8V5h14v3M4 8h16v12H4z" /><path d="M20 12h-5v4h5" /></>,
  swapVert: <path d="M7 4v16m-4-4 4 4 4-4M17 20V4m-4 4 4-4 4 4" />,
  arrow: <path d="M5 12h14m-5-5 5 5-5 5" />, spin: <path d="M12 4a8 8 0 1 0 8 8" />, check: <path d="m5 12 4 4L19 6" />,
  chevR: <path d="m9 6 6 6-6 6" />, swapH: <path d="M7 7h11l-3-3M17 17H6l3 3" />, cycle: <path d="m8 9 4-4 4 4M8 15l4 4 4-4" />,
  move: <path d="M4 8h13l-3-3M20 16H7l3 3" />, swap: <path d="M7 4v16l-3-3M17 20V4l3 3" />, send: <path d="M4 12 20 4l-6 16-3-7z" />, receive: <path d="M12 4v12m-5-5 5 5 5-5M5 20h14" />,
  back: <path d="M19 12H5m6-6-6 6 6 6" />, cal: <><rect x="4" y="5" width="16" height="15" rx="2" /><path d="M8 3v4M16 3v4M4 10h16" /></>,
  sol: <path d="M6 5h13l-3 3H3zm-3 5h13l3 3H6zm3 5h13l-3 3H3z" fill="currentColor" stroke="none" />,
}
export type IconName = keyof typeof P
export const Icon = ({ name, className = 'icon', w = 1.7 }: { name: IconName; className?: string; w?: number }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={w} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{P[name]}</svg>
)

// Endpoint mark: official logo where we have one, else a letter tile. Same size everywhere; apps are rounded squares, chains are circles.
// Base and Robinhood Chain marks sit at ~62% in a dark circle; avatar/coin logos fill their tile.
const INSET = new Set(['base', 'robinhood'])
const FULL = new Set(['drift', 'kamino', 'jupiter', 'hyperliquid', 'marginfi', 'aave', 'morpho', 'limitless', 'arbitrum', 'polygon', 'optimism', 'bnb', 'avalanche', 'hyperevm'])
export function Mark({ k, className = '' }: { k: string; className?: string }) {
  if (k.startsWith('swap')) return <span className={`mk sw ${className}`} aria-label="swap"><Icon name="swapH" w={2.4} /></span>
  const x = BY[k]
  return (
    <span className={`mk ${x.g === 'chain' ? 'c' : ''} ${className}`} style={{ color: COL[k] || 'var(--dim)' }} aria-hidden="true">
      {LOGO[k] ? <img src={LOGO[k]} alt="" className={INSET.has(k) ? 'inset' : FULL.has(k) ? 'full' : undefined} /> : x.n[0]}
    </span>
  )
}
export const Tk = ({ t }: { t: Token }) => <span className="tk" style={{ color: TCOL[t] }} aria-hidden="true">{TGL[t]}</span>
