import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  collectPhoenixChartStoryPages,
  mapPhoenixStoryToChartMarkers,
  phoenixStorySlugForSymbol,
} from './phoenix.chart-stories';
import type {
  StoryDetail,
  StoryEvent,
  StorySummary,
} from '@/features/feed/feed.types';

describe('phoenixStorySlugForSymbol', () => {
  it('maps only the approved Bitcoin market to its production Story', () => {
    assert.equal(phoenixStorySlugForSymbol('BTC-PERP'), 'bitcoin');
    assert.equal(phoenixStorySlugForSymbol(' btc '), 'bitcoin');
    assert.equal(phoenixStorySlugForSymbol('SOL-PERP'), null);
    assert.equal(phoenixStorySlugForSymbol(''), null);
  });
});

describe('collectPhoenixChartStoryPages', () => {
  it('loads every page using the server-provided next offset', async () => {
    const requestedOffsets: number[] = [];
    const result = await collectPhoenixChartStoryPages(async (offset) => {
      requestedOffsets.push(offset);
      return offset === 0
        ? storyDetail(['Newest', 'Middle'], true, 2)
        : storyDetail(['Oldest'], false, null, 2);
    });

    assert.deepEqual(requestedOffsets, [0, 2]);
    assert.deepEqual(result.events.map((entry) => entry.text), [
      'Newest',
      'Middle',
      'Oldest',
    ]);
  });

  it('rejects pagination that claims more data without advancing', async () => {
    await assert.rejects(
      collectPhoenixChartStoryPages(async () => storyDetail(['Event'], true, 0)),
      /did not advance/,
    );
  });
});

describe('mapPhoenixStoryToChartMarkers', () => {
  const candles = [
    { time: 1_700_000_000, close: 100 },
    { time: 1_700_000_060, close: 101 },
    { time: 1_700_000_120, close: 102 },
  ];

  it('creates one marker per occupied candle and groups only same-candle developments', () => {
    const markers = mapPhoenixStoryToChartMarkers(candles, story(), [
      event('Older development', '2023-11-14T22:13:25.000Z'),
      event('Same candle development', '2023-11-14T22:13:55.000Z'),
      event('Latest development', '2023-11-14T22:14:40.000Z'),
    ]);

    assert.equal(markers.length, 2);
    assert.equal(markers[0].id, 'phoenix-chart-story-bitcoin-1700000000000');
    assert.equal(markers[0].candleIndex, 0);
    assert.equal(markers[1].candleIndex, 1);
    assert.equal(markers[1].time, 1_700_000_060_000);
    assert.equal(markers[1].price, 101);
    assert.deepEqual(
      markers[0].events.map((development) => development.text),
      ['Same candle development', 'Older development'],
    );
  });

  it('anchors to the candle interval at or before the activity instead of the nearest timestamp', () => {
    const markers = mapPhoenixStoryToChartMarkers(
      candles,
      story(),
      [event('Development', '2023-11-14T22:14:50.000Z')],
    );

    assert.equal(markers[0]?.candleIndex, 1);
  });

  it('clamps newer developments to the live candle and hides older unloaded developments', () => {
    const markers = mapPhoenixStoryToChartMarkers(
      candles,
      story(),
      [
        event('Future', '2023-11-14T23:00:00.000Z'),
        event('Before', '2023-11-14T20:00:00.000Z'),
      ],
    );

    assert.equal(markers.length, 1);
    assert.equal(markers[0].candleIndex, 2);
    assert.deepEqual(markers[0].events.map((development) => development.text), ['Future']);
  });
});

function story(overrides: Partial<StorySummary> = {}): StorySummary {
  return {
    storySlug: 'bitcoin',
    name: 'Bitcoin',
    latestDevelopment: 'Latest development',
    eventCount: 2,
    updatedAt: '2023-11-14T22:14:40.000Z',
    imageUrl: 'https://example.com/bitcoin.jpg',
    imageKind: 'content',
    imageAttribution: 'Example',
    ...overrides,
  };
}

function event(text: string, eventAt: string): StoryEvent {
  return {
    text,
    eventAt,
    imageUrl: null,
    imageKind: null,
    imageAttribution: null,
  };
}

function storyDetail(
  texts: readonly string[],
  hasMore: boolean,
  nextOffset: number | null,
  offset = 0,
): StoryDetail {
  return {
    story: story({ eventCount: 3 }),
    events: texts.map((text, index) => event(
      text,
      new Date(1_700_000_000_000 - (offset + index) * 60_000).toISOString(),
    )),
    pagination: {
      limit: 50,
      offset,
      total: 3,
      hasMore,
      nextOffset,
    },
  };
}
