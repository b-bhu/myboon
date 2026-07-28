import type { BottomNavItem } from '@/features/feed/feed.types';

export const BOTTOM_NAV_ITEMS: BottomNavItem[] = [
  { key: 'feed', icon: 'rss-feed', label: 'Feed', route: '/' },
  { key: 'predict', icon: 'psychology', label: 'Polymarket', route: '/markets/polymarket' },
  { key: 'trade', icon: 'bar-chart', label: 'Pacifica', route: '/markets/pacifica' },
  { key: 'defi', icon: 'swap-horiz', label: 'Defi', route: '/swap' },
];
