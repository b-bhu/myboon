export type Img = { src: string; w: number; h: number; alt: string }

export const crops = {
  story: { src: '/landing/story.png', w: 574, h: 301, alt: 'U.S.–Iran Conflict story card with timeline' },
  drift: { src: '/landing/drift.png', w: 795, h: 461, alt: 'Latest update: Drift Protocol attacker resurfaces' },
  oneinch: { src: '/landing/oneinch.png', w: 795, h: 261, alt: 'Latest update: 1inch Card winds down' },
  cal: { src: '/landing/cal.png', w: 792, h: 394, alt: 'Market calendar with scheduled events' },
  sol: { src: '/landing/sol.png', w: 718, h: 106, alt: 'SOL price row' },
  zec: { src: '/landing/zec.png', w: 718, h: 104, alt: 'ZEC price row' },
  swap: { src: '/landing/swap.png', w: 805, h: 609, alt: 'Swap card: SOL to USDC' },
  tabs: { src: '/landing/tabs.png', w: 813, h: 102, alt: 'Feed, Apps and Wallet tab bar' },
  swipe: { src: '/landing/swipe.png', w: 756, h: 111, alt: 'Slide to swap control' },
  connect: { src: '/landing/connect.png', w: 201, h: 67, alt: 'Connect Solana wallet button' },
} satisfies Record<string, Img>

export const apps = {
  jupiter: { name: 'Jupiter', kind: 'Swap', logo: '/landing/logo-jupiter.svg' },
  phoenix: { name: 'Phoenix', kind: 'Perps', logo: '/landing/logo-phoenix.svg' },
  pacifica: { name: 'Pacifica', kind: 'Perps', logo: '/landing/logo-pacifica.svg' },
  meteora: { name: 'Meteora', kind: 'Liquidity', logo: '/landing/logo-meteora.svg' },
  polymarket: { name: 'Polymarket', kind: 'Predictions', logo: '/landing/logo-polymarket.svg' },
}

export type TileKey = keyof typeof crops | keyof typeof apps

/** Hero tile: x/y in % of hero, width px, rotation deg, path segment. */
export type HeroTile = { k: keyof typeof crops; x: number; y: number; w: number; r: number; seg: 'b' | 'g' | 'n' }

export const heroTiles: { d: HeroTile[]; m: HeroTile[] } = {
  d: [
    { k: 'drift', x: 8, y: 26, w: 220, r: -7, seg: 'b' },
    { k: 'story', x: 29, y: 17, w: 250, r: 5, seg: 'b' },
    { k: 'sol', x: 50, y: 62, w: 250, r: -4, seg: 'b' },
    { k: 'swap', x: 80, y: 22, w: 230, r: 6, seg: 'g' },
    { k: 'tabs', x: 90, y: 66, w: 250, r: -5, seg: 'g' },
    { k: 'zec', x: 13, y: 66, w: 210, r: 4, seg: 'n' },
  ],
  m: [
    { k: 'story', x: 34, y: 18, w: 230, r: -6, seg: 'b' },
    { k: 'sol', x: 68, y: 57, w: 210, r: 5, seg: 'b' },
    { k: 'swap', x: 30, y: 69, w: 180, r: -6, seg: 'g' },
  ],
}

/** Section tile: x/y %, width px, rotation, parallax depth, chain order (0 = not on page path). */
export type SecTile = { k: TileKey; x: number; y: number; w: number; r: number; dp: number; ch: number }

const t = (k: TileKey, x: number, y: number, w: number, r: number, dp: number, ch = 0): SecTile => ({ k, x, y, w, r, dp, ch })

export const sectionTiles = {
  feed: {
    d: [t('story', 24, 20, 330, -5, 0.25, 1), t('oneinch', 78, 18, 320, 4, 0.15), t('cal', 72, 72, 360, -4, 0.3), t('drift', 20, 74, 300, 5, 0.1)],
    m: [t('story', 35, 17, 250, -5, 0.2, 1), t('cal', 62, 73, 280, 4, 0.2)],
  },
  apps: {
    d: [t('jupiter', 19, 24, 280, -6, 0.2), t('phoenix', 50, 13, 260, 4, 0.12), t('pacifica', 81, 26, 280, -4, 0.25, 2), t('meteora', 21, 73, 280, 5, 0.15), t('polymarket', 78, 75, 300, -5, 0.3)],
    m: [t('jupiter', 28, 16, 190, -6, 0.2), t('phoenix', 74, 22, 180, 5, 0.1, 2), t('meteora', 30, 70, 200, 4, 0.2), t('polymarket', 70, 77, 200, -4, 0.15)],
  },
  wallet: {
    d: [t('swipe', 50, 71, 520, -3, 0.2, 3), t('swap', 22, 26, 300, -6, 0.3), t('tabs', 79, 22, 300, 5, 0.15), t('connect', 82, 64, 170, 6, 0.1)],
    m: [t('swipe', 50, 70, 330, -3, 0.2, 3), t('swap', 30, 19, 200, -6, 0.2), t('connect', 76, 26, 130, 6, 0.1)],
  },
}

export const X_URL = 'https://x.com/myboonapp'
