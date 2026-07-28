import type { Href } from 'expo-router';

export function getPredictMarketHref(slug: string): Href {
  const sport = sportForMarketSlug(slug);
  if (sport) {
    return {
      pathname: '/markets/polymarket/sport/[sport]/[slug]',
      params: { sport, slug },
    };
  }
  return {
    pathname: '/markets/polymarket/market/[slug]',
    params: { slug },
  };
}

function sportForMarketSlug(slug: string): string | null {
  if (slug.startsWith('crint-')) return 'cricket';

  const legacySport = slug.match(/^cric(epl|ucl|ipl)-/);
  if (legacySport) return legacySport[1];

  const directSport = slug.match(/^(epl|ucl|ipl|fifwc)-/);
  if (directSport) return directSport[1];

  const datedSport = slug.match(/^([a-z0-9]+)-.+-\d{4}-\d{2}-\d{2}$/);
  return datedSport?.[1] ?? null;
}
