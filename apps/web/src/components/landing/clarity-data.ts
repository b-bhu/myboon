/** Shared cadence and fixture data for the landing clarity sections (issue #564). */

/** One shared cadence: hero steps, strip phones and the story timeline all tick together. */
export const TICK_MS = 1600
export const nextTick = (k: number) => (k + 1) % 3

/** The three phones shown in the app-in-motion strip, in Read → Pick → Act order. */
export const STRIP_STEPS = [
  { img: '/landing/feed-phone.png', w: 776, h: 1686, cap: 'Read', alt: 'MyBoon feed screen' },
  { img: '/landing/apps-phone.png', w: 776, h: 1688, cap: 'Pick', alt: 'MyBoon apps screen' },
  { img: '/landing/wallet-phone.png', w: 780, h: 1688, cap: 'Act', alt: 'MyBoon wallet screen' },
] as const

/** The four labelled app tiles after the apps burst. `viz` picks the mini-chart. */
export const TILE_DEFS = [
  { name: 'Polymarket', kind: 'Polymarket', logo: '/landing/logo-polymarket.svg', viz: 'odds' },
  { name: 'Pacifica', kind: 'Perps', logo: '/landing/logo-pacifica.svg', viz: 'perps' },
  { name: 'Phoenix', kind: 'Spot', logo: '/landing/logo-phoenix.svg', viz: 'spot' },
  { name: 'Meteora', kind: 'Earn', logo: '/landing/logo-meteora.svg', viz: 'earn' },
] as const

/** The three-step sample timeline next to the story card. */
export const TIMELINE_STEPS = [
  { time: '09:12', label: 'News' },
  { time: '09:13', label: 'Why it moved' },
  { time: '09:14', label: 'Swapped' },
] as const
