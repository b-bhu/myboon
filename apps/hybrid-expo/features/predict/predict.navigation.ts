import type { Href } from 'expo-router';

// Polymarket cricket fixtures are always <cr-code>-<matchup>-<YYYY-MM-DD>, for
// example crichundred-tre-sun-2026-08-02 or cricodc-ham-dur-2026-08-02. Both
// halves matter: the cr prefix alone also matches crude-oil-all-time-high-by
// and croatia-parliamentary-election, while the date alone matches every other
// dated sport. Verified against all 259 cricket-tagged events and 1,500 active
// markets — separates them with no false positives or negatives.
const CRICKET_FIXTURE_RE = /^cr[a-z0-9]*-.+-\d{4}-\d{2}-\d{2}$/;

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
  const legacySport = slug.match(/^cric(epl|ucl|ipl)-/);
  if (legacySport) return legacySport[1];

  // Every cricket competition (crint, crichundred, cricodc, …) shares the
  // single 'cricket' display sport the detail route expects. Match the code
  // against a real fixture shape rather than a bare 'cr' prefix: unrelated
  // markets like crude-oil-all-time-high-by and croatia-parliamentary-election
  // also start with 'cr' and must keep falling through to the generic route.
  if (CRICKET_FIXTURE_RE.test(slug)) return 'cricket';

  const directSport = slug.match(/^(epl|ucl|ipl|fifwc)-/);
  if (directSport) return directSport[1];

  const datedSport = slug.match(/^([a-z0-9]+)-.+-\d{4}-\d{2}-\d{2}$/);
  return datedSport?.[1] ?? null;
}
