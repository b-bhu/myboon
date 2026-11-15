import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chartStoryMarkersToAnnotations } from './chart-story-annotations';
import type { ChartStoryMarker } from './chart-story-annotations';

const phoenixMarker: ChartStoryMarker = {
  id: 'phoenix:bitcoin:42',
  time: 1_700_000_012_000,
  story: {
    name: 'Bitcoin ETF flows',
    latestDevelopment: 'Inflows hit a monthly record.',
    imageUrl: 'https://cdn.example.com/story.jpg',
  },
  events: [
    { text: 'Daily inflow topped $1B.', imageUrl: 'https://cdn.example.com/event.jpg' },
    { text: 'Second development.' },
  ],
};

const polymarketMarker: ChartStoryMarker = {
  id: 'polymarket:fed-rates:7',
  time: 1_700_001_988_000,
  story: {
    name: 'Will the Fed cut rates?',
    latestDevelopment: 'Minutes lean dovish.',
  },
  events: [],
};

describe('chart story markers to annotations', () => {
  it('maps a Phoenix-style marker from its first event', () => {
    const [annotation] = chartStoryMarkersToAnnotations([phoenixMarker]);
    assert.deepEqual(annotation, {
      id: 'phoenix:bitcoin:42',
      timeMs: 1_700_000_012_000,
      label: 'Daily inflow topped $1B.',
      accessibilityLabel: 'Bitcoin ETF flows. Daily inflow topped $1B.',
      imageUrl: 'https://cdn.example.com/event.jpg',
      fallbackText: '✦',
      tone: 'accent',
    });
  });

  it('falls back to the story name and story image for a Polymarket-style marker without events', () => {
    const [annotation] = chartStoryMarkersToAnnotations([polymarketMarker]);
    assert.deepEqual(annotation, {
      id: 'polymarket:fed-rates:7',
      timeMs: 1_700_001_988_000,
      label: 'Will the Fed cut rates?',
      accessibilityLabel: 'Will the Fed cut rates?. Minutes lean dovish.',
      imageUrl: undefined,
      fallbackText: '✦',
      tone: 'accent',
    });
  });

  it('prefers the first event text and falls back to image resolution per venue', () => {
    const [annotation] = chartStoryMarkersToAnnotations([
      {
        ...phoenixMarker,
        events: [{ text: null, imageUrl: null }],
      },
    ]);
    assert.equal(annotation.label, 'Bitcoin ETF flows');
    assert.equal(annotation.imageUrl, 'https://cdn.example.com/story.jpg');
  });

  it('returns an empty array for empty input', () => {
    assert.deepEqual(chartStoryMarkersToAnnotations([]), []);
  });
});
