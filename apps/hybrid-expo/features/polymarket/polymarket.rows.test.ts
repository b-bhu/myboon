/**
 * Unit tests for the pure Polymarket row logic, shaped like
 * `features/perps/pacifica.rows.test.ts`. Run:
 * `pnpm --filter hybrid-expo test:markets`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { NO_DATA, formatUsdAccessible, formatUsdCompact } from '@/lib/format';

import {
  POLYMARKET_COLUMNS,
  polymarketChance,
  polymarketEndsLabel,
  polymarketMatchesQuery,
  polymarketToRow,
  sortFeedItems,
} from './polymarket.rows';
import type { FeedItem, FeedItemBinary, FeedItemMatch } from './polymarket.types';

const binaryFeed: FeedItemBinary = {
  type: 'binary',
  slug: 'fed-rate-cut-in-november',
  title: 'Fed rate cut in November?',
  category: 'Economy',
  tags: ['Fed', 'Rates'],
  status: 'upcoming',
  image: 'https://images/myboon/market.webp',
  active: true,
  volume: 1_234_567,
  price: 0.68,
  endDate: '2026-11-30T00:00:00Z',
  outcomes: [
    { label: 'Yes', price: 0.68 },
    { label: 'No', price: 0.32 },
  ],
};

const matchFeed: FeedItemMatch = {
  type: 'match',
  slug: 'epl-liv-mci-2026-12-01',
  title: 'Liverpool vs Man City',
  category: 'EPL',
  sport: 'epl',
  tags: ['epl'],
  status: 'upcoming',
  active: true,
  teams: [
    {
      name: 'Liverpool FC',
      logo: 'https://images/myboon/liv.png',
      abbreviation: 'LIV',
      alias: null,
      color: null,
      ordering: null,
    },
    {
      name: 'Manchester City FC',
      logo: 'https://images/myboon/mci.png',
      abbreviation: 'MCI',
      alias: null,
      color: null,
      ordering: null,
    },
  ],
  outcomes: [
    { label: 'Liverpool FC', price: 0.55 },
    { label: 'Manchester City FC', price: 0.25 },
    { label: 'Draw', price: 0.2 },
  ],
  gameStartTime: '2026-12-01T17:30:00Z',
  startDate: '2026-12-01T17:30:00Z',
  endDate: '2026-12-01T20:00:00Z',
  image: 'https://images/myboon/epl.webp',
  volume: 900_000,
};

function feed(...items: FeedItem[]): FeedItem[] {
  return items;
}

test('binary rows render the market image as a token lead with a title letter', () => {
  const row = polymarketToRow(binaryFeed);
  assert.equal(row.title, 'Fed rate cut in November?');
  assert.equal(row.subtitle, 'Economy');
  assert.equal(row.lead.kind, 'token');
  if (row.lead.kind === 'token') {
    assert.equal(row.lead.venueIconUrl, 'https://images/myboon/market.webp');
    assert.equal(row.lead.identityIconUrl, null);
    assert.equal(row.lead.letter, 'F');
  }
});

test('binary rows link to the generic market detail route', () => {
  const row = polymarketToRow(binaryFeed);
  assert.deepEqual(
    row.href,
    '/markets/polymarket/market/fed-rate-cut-in-november',
  );
});

test('binary rows surface chance, volume and end date', () => {
  const row = polymarketToRow(binaryFeed);
  assert.equal(row.cells[0].text, '68%');
  assert.equal(row.cells[1].text, formatUsdCompact(1_234_567));
  assert.equal(row.cells[2].text, 'Nov 30');
  assert.ok(!row.cells[2].tone, 'upcoming markets are not dimmed');
});

test('closed binary rows dim the end cell', () => {
  const row = polymarketToRow({ ...binaryFeed, status: 'closed' });
  assert.equal(row.cells[2].tone, 'dim');
});

test('binary a11y labels name the market, chance, volume and end date', () => {
  const row = polymarketToRow(binaryFeed);
  assert.ok(row.a11yLabel.includes('Open Fed rate cut in November? prediction market.'));
  assert.ok(row.a11yLabel.includes('68% chance of the leading outcome.'));
  assert.ok(row.a11yLabel.includes(`${formatUsdAccessible(1_234_567)} total volume.`));
  assert.ok(row.a11yLabel.includes('Ends Nov 30.'));
});

test('binary rows without a finite price fall back to an em dash', () => {
  const row = polymarketToRow({ ...binaryFeed, price: Number.NaN });
  assert.equal(row.cells[0].text, NO_DATA);
  assert.ok(!row.a11yLabel.includes('chance of the leading outcome.'));
});

test('match rows render a pair lead from team logos and letters', () => {
  const row = polymarketToRow(matchFeed);
  assert.equal(row.lead.kind, 'pair');
  if (row.lead.kind === 'pair') {
    assert.equal(row.lead.x.venueIconUrl, 'https://images/myboon/liv.png');
    assert.equal(row.lead.y.venueIconUrl, 'https://images/myboon/mci.png');
    assert.equal(row.lead.x.letter, 'L');
    assert.equal(row.lead.y.letter, 'M');
  }
});

test('match rows show the favorite outcome as their chance', () => {
  const row = polymarketToRow(matchFeed);
  assert.equal(row.cells[0].text, '55%');
  assert.equal(polymarketChance(matchFeed), 0.55);
});

test('match rows label the sport and link to the sport detail route', () => {
  const row = polymarketToRow(matchFeed);
  assert.equal(row.subtitle, 'EPL');
  assert.deepEqual(
    row.href,
    '/markets/polymarket/sport/epl/epl-liv-mci-2026-12-01',
  );
});

test('cricket fixtures route to the cricket sport detail route', () => {
  const cricket: FeedItemMatch = {
    ...matchFeed,
    slug: 'crichundred-tre-sun-2026-08-02',
    category: 'CRICHUNDRED',
  };
  const row = polymarketToRow(cricket);
  assert.deepEqual(
    row.href,
    '/markets/polymarket/sport/cricket/crichundred-tre-sun-2026-08-02',
  );
});

test('live matches flag Live in the ends cell and subtitle', () => {
  const row = polymarketToRow({ ...matchFeed, status: 'live' });
  assert.equal(row.cells[2].text, 'Live');
  assert.equal(row.subtitle, 'EPL · Live');
  assert.equal(polymarketEndsLabel({ ...matchFeed, status: 'live' }), 'Live');
});

test('upcoming matches show the game-start date', () => {
  assert.equal(polymarketEndsLabel(matchFeed), 'Dec 1');
  const row = polymarketToRow(matchFeed);
  assert.equal(row.cells[2].text, 'Dec 1');
});

test('team letters fall back to the name initial when there is no abbreviation', () => {
  const row = polymarketToRow({
    ...matchFeed,
    teams: [
      {
        name: 'Liverpool FC',
        logo: null,
        abbreviation: null,
        alias: null,
        color: null,
        ordering: null,
      },
      {
        name: 'Manchester City FC',
        logo: null,
        abbreviation: null,
        alias: null,
        color: null,
        ordering: null,
      },
    ],
  });
  assert.equal(row.lead.kind, 'pair');
  if (row.lead.kind === 'pair') {
    assert.equal(row.lead.x.venueIconUrl, 'https://images/myboon/epl.webp');
    assert.equal(row.lead.y.venueIconUrl, null);
    assert.equal(row.lead.x.letter, 'L');
    assert.equal(row.lead.y.letter, 'M');
  }
});

test('rows sort by volume descending', () => {
  const sorted = sortFeedItems(feed(matchFeed, binaryFeed));
  assert.deepEqual(sorted, feed(binaryFeed, matchFeed));
});

test('matchesQuery hits titles, categories, tags and team names, case-insensitively', () => {
  assert.equal(polymarketMatchesQuery(binaryFeed, 'rate cut'), true);
  assert.equal(polymarketMatchesQuery(binaryFeed, 'ECONOMY'), true);
  assert.equal(polymarketMatchesQuery(binaryFeed, 'fed'), true);
  assert.equal(polymarketMatchesQuery(matchFeed, 'liverpool'), true);
  assert.equal(polymarketMatchesQuery(matchFeed, ''), true);
  assert.equal(polymarketMatchesQuery(binaryFeed, 'cricket'), false);
});

test('polymarket columns are Chance, Volume and Ends with Chance active', () => {
  const [chance, volume, ends] = POLYMARKET_COLUMNS;
  assert.deepEqual(
    [chance.key, volume.key, ends.key],
    ['chance', 'volume', 'ends'],
  );
  assert.equal(chance.active, true);
});
