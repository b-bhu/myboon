import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchCalendarHistory } from './calendar.api';

/** A complete /calendar/history answer the validator must accept (#703). */
const validHistory = {
  entity: { slug: 'us-cpi', name: 'US CPI' },
  markets: [{ symbol: 'BTC', displaySymbol: 'BTC', displayName: 'Bitcoin', rank: 1 }],
  releases: [{
    date: '2026-11-12', startsAt: null, title: 'Inflation Rate YoY (Oct)', period: 'Oct',
    unit: null, actual: 3.1, estimate: 3.3, previous: 3.0, moves: [{ symbol: 'BTC', changePct: null }],
  }],
};

test('fetchCalendarHistory requests entity and before on /calendar/history', async () => {
  const originalFetch = globalThis.fetch;
  const originalBase = process.env.EXPO_PUBLIC_API_BASE_URL;
  const urls: string[] = [];
  try {
    process.env.EXPO_PUBLIC_API_BASE_URL = 'https://feed-api.example.test';
    globalThis.fetch = async (input) => {
      urls.push(String(input));
      return Response.json(validHistory);
    };
    const result = await fetchCalendarHistory('us-cpi', '2026-12-10');
    assert.equal(urls[0], 'https://feed-api.example.test/calendar/history?entity=us-cpi&before=2026-12-10');
    assert.deepEqual(result, validHistory);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalBase === undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL;
    else process.env.EXPO_PUBLIC_API_BASE_URL = originalBase;
  }
});

test('fetchCalendarHistory rejects a malformed payload and a failing status', async () => {
  const originalFetch = globalThis.fetch;
  try {
    // The envelope itself broken: releases not an array, entity without a slug.
    globalThis.fetch = async () => Response.json({ entity: { slug: 'us-cpi' }, markets: [], releases: 'nope' });
    await assert.rejects(fetchCalendarHistory('us-cpi', '2026-12-10'), /could not be loaded/);
    globalThis.fetch = async () => Response.json({ entity: {}, markets: [], releases: [] });
    await assert.rejects(fetchCalendarHistory('us-cpi', '2026-12-10'));

    // A release without a date, and a market column without a header.
    globalThis.fetch = async () => Response.json({ ...validHistory, releases: [{
      startsAt: null, title: 'CPI', unit: null, actual: 1, estimate: 1, moves: [],
    }] });
    await assert.rejects(fetchCalendarHistory('us-cpi', '2026-12-10'));
    globalThis.fetch = async () => Response.json({ ...validHistory, markets: [{ symbol: 'BTC' }] });
    await assert.rejects(fetchCalendarHistory('us-cpi', '2026-12-10'));
    // A moves list that is not an array.
    globalThis.fetch = async () => Response.json({ ...validHistory, releases: [{ ...validHistory.releases[0], moves: 'nope' }] });
    await assert.rejects(fetchCalendarHistory('us-cpi', '2026-12-10'));

    // Non-2xx statuses never satisfy the table, not even with a valid body.
    globalThis.fetch = async () => Response.json(validHistory, { status: 404 });
    await assert.rejects(fetchCalendarHistory('us-cpi', '2026-12-10'));
    globalThis.fetch = async () => Response.json({ error: 'Calendar history unavailable' }, { status: 503 });
    await assert.rejects(fetchCalendarHistory('us-cpi', '2026-12-10'), /could not be loaded/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
