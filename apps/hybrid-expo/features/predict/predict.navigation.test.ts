import assert from 'node:assert/strict';
import test from 'node:test';
import { getPredictMarketHref } from './predict.navigation';

function sportFor(slug: string): string | null {
  const href = getPredictMarketHref(slug);
  if (typeof href === 'string') return null;
  const params = href.params as Record<string, string> | undefined;
  return href.pathname.includes('/sport/') ? params?.sport ?? null : null;
}

test('routes every cricket competition to the shared cricket detail route', () => {
  // Tag discovery spans many league codes, all of which share one display sport.
  for (const slug of [
    'crint-sco2-are2-2026-08-03',
    'crichundred-tre-sun-2026-08-02',
    'crichundredw-mi-man-2026-08-02',
    'cricodc-ham-dur-2026-08-02',
    'cricodcl2w-sus-mid-2026-08-02',
    'cricmukono-mpa-bus-2026-07-29',
    'crickerala-pal-bla-2026-07-28',
    'criccpl-a-b-2026-08-02',
    'cricecseng-x-y-2026-08-02',
  ]) {
    assert.equal(sportFor(slug), 'cricket', `${slug} should route to cricket`);
  }
});

test('leaves non-cricket markets that merely start with cr on the generic route', () => {
  // crude-oil-all-time-high-by is a live, high-volume Polymarket event; a bare
  // 'cr' prefix test would send it to the cricket detail route and 404.
  for (const slug of [
    'crude-oil-all-time-high-by',
    'crypto-market-cap-2026',
    'croatia-parliamentary-election',
    'cr7-retires-in-2026',
  ]) {
    assert.equal(sportFor(slug), null, `${slug} must not route to a sport`);
  }
});

test('keeps legacy cricket-coded soccer competitions on their own routes', () => {
  assert.equal(sportFor('cricepl-ars-che-2026-08-15'), 'epl');
  assert.equal(sportFor('cricucl-rma-bar-2026-08-15'), 'ucl');
  assert.equal(sportFor('cricipl-mi-csk-2026-04-10'), 'ipl');
});

test('keeps direct sport prefixes and generic dated fixtures unchanged', () => {
  assert.equal(sportFor('epl-ars-che-2026-08-15'), 'epl');
  assert.equal(sportFor('fifwc-bra-arg-2026-06-20'), 'fifwc');
  assert.equal(sportFor('nba-lal-bos-2026-03-01'), 'nba');
});
