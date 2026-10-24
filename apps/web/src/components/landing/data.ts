export type Img = { src: string; w: number; h: number; alt: string }

/** Screenshot crops of the real app, used as Feed tiles. */
export const crops = {
  oneinch: { src: '/landing/oneinch.png', w: 795, h: 261, alt: 'Latest update card from the Feed' },
  cal: { src: '/landing/cal.png', w: 792, h: 394, alt: 'Market calendar with scheduled events' },
} satisfies Record<string, Img>

export type AppTile = {
  name: string
  kind: string
  logo: string
  /** Desktop: centre x/y in % of the section, size px, tilt deg. */
  d: { x: number; y: number; w: number; r: number }
  /** Mobile placement, or null when the tile is desktop-only. */
  m: { x: number; y: number; w: number; r: number } | null
  /** Parallax depth. */
  dp: number
  /** Node on the page route. */
  node?: boolean
}

/** Seven unlabelled glass tiles in front of "Apps" (five on mobile). */
export const appTiles: AppTile[] = [
  { name: 'Polymarket', kind: 'Predict', logo: '/landing/logo-polymarket.svg', d: { x: 23, y: 37, w: 88, r: -14 }, m: { x: 22, y: 40, w: 64, r: -14 }, dp: 0.6 },
  { name: 'Phoenix', kind: 'Perps', logo: '/landing/logo-phoenix.svg', d: { x: 31, y: 60, w: 76, r: 10 }, m: { x: 35, y: 53, w: 58, r: 10 }, dp: 0.9 },
  { name: 'Pacifica', kind: 'Perps', logo: '/landing/logo-pacifica.svg', d: { x: 19, y: 63, w: 64, r: -6 }, m: { x: 16, y: 68, w: 56, r: -6 }, dp: 0.4, node: true },
  { name: 'Jupiter', kind: 'Swap', logo: '/landing/logo-jupiter.svg', d: { x: 71, y: 28, w: 84, r: 12 }, m: { x: 77, y: 33, w: 62, r: 12 }, dp: 0.7 },
  { name: 'Drift', kind: 'Perps', logo: '/wallet-mock/drift.png', d: { x: 88, y: 41, w: 64, r: 14 }, m: null, dp: 0.3 },
  { name: 'Meteora', kind: 'Liquidity', logo: '/landing/logo-meteora.svg', d: { x: 79, y: 62, w: 74, r: -18 }, m: { x: 81, y: 57, w: 58, r: -16 }, dp: 0.8 },
  { name: 'Hyperliquid', kind: 'Perps', logo: '/wallet-mock/hyperliquid.png', d: { x: 61, y: 72, w: 68, r: 8 }, m: null, dp: 0.5 },
]

/** Section card: centre x/y %, width px, tilt deg, parallax depth. */
export type Place = { x: number; y: number; w: number; r: number; dp?: number }

export const X_URL = 'https://x.com/myboonapp'
export const STORE_URL = '/downloads'
