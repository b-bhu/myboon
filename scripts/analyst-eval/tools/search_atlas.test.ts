// Unit tests for the atlas search tool: fake fetchImpl, no network.
import { describe, expect, it } from 'vitest';

import { getShelvesByIds, sanitizeAtlasQuery, searchAtlas } from './search_atlas.js';

const SUPABASE_URL = 'https://db.example.com';
const SERVICE_KEY = 'service-role-secret';
const ENV = { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY };

const SHELF = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'competitions',
  name: 'Competitions',
  type: 'group',
  aliases: ['leagues'],
  summary: 'Esports competitions.',
};
const ITEM = {
  id: '33333333-3333-4333-8333-333333333333',
  item_key: 'bin-kaisa-top',
  title: "Bin's Kai'Sa top debut",
  summary: 'Champion pickup story.',
  main_shelf_id: '11111111-1111-4111-8111-111111111111',
};

interface FetchCall {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

/** Records requests; url-aware responses (tables answer themselves). */
function recordingFetch(respond: (url: string) => unknown[] | { error: string; status: number }) {
  const calls: FetchCall[] = [];
  const impl: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, method: init?.method ?? 'GET', headers, body: init?.body });
    const want = respond(url);
    if (!Array.isArray(want)) {
      return new Response(want.error, { status: want.status });
    }
    return new Response(JSON.stringify(want), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { impl, calls };
}

const byTable = (shelves: unknown[], items: unknown[]) => (url: string) =>
  url.includes('/rest/v1/shelves') ? shelves : items;

const decodedQuery = (url: string) =>
  decodeURIComponent((url.split('?')[1] ?? '').replace(/\+/g, ' '));

describe('searchAtlas', () => {
  it('issues two GETs with apikey + bearer + Accept-Profile: atlas and no body', async () => {
    const { impl, calls } = recordingFetch(byTable([SHELF], [ITEM]));
    const out = await searchAtlas('Bin', { fetchImpl: impl, env: ENV });
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
    expect(calls.every((c) => c.body === undefined)).toBe(true);
    for (const call of calls) {
      expect(call.headers.get('apikey')).toBe(SERVICE_KEY);
      expect(call.headers.get('authorization')).toBe(`Bearer ${SERVICE_KEY}`);
      expect(call.headers.get('Accept-Profile')).toBe('atlas');
    }
    expect(out.shelves).toEqual([SHELF]);
    expect(out.items).toEqual([ITEM]);
  });

  it('builds the PostgREST or=(...) filters for shelves and items', async () => {
    const { impl, calls } = recordingFetch(() => []);
    await searchAtlas('Bin', { fetchImpl: impl, env: ENV });
    const shelfUrl = calls.find((c) => c.url.includes('/rest/v1/shelves'))!.url;
    const itemUrl = calls.find((c) => c.url.includes('/rest/v1/items'))!.url;
    expect(decodedQuery(shelfUrl)).toBe(
      'select=id,slug,name,type,aliases,summary&or=(name.ilike.*Bin*,slug.ilike.*Bin*,aliases.cs.{"Bin"})&limit=8',
    );
    expect(decodedQuery(itemUrl)).toBe(
      'select=id,item_key,title,summary,main_shelf_id&or=(title.ilike.*Bin*,summary.ilike.*Bin*)&limit=8',
    );
  });

  it('sanitizes PostgREST filter syntax out of the query', async () => {
    const { impl, calls } = recordingFetch(byTable([], []));
    await searchAtlas('Bin, (LPL)*"{\\} ', { fetchImpl: impl, env: ENV });
    expect(calls).toHaveLength(2);
    const shelfUrl = calls.find((c) => c.url.includes('/rest/v1/shelves'))!.url;
    const decoded = decodedQuery(shelfUrl);
    expect(decoded).toContain('name.ilike.*Bin LPL*');
    expect(decoded).toContain('aliases.cs.{"Bin LPL"}');
    // the only parentheses are the or=(...) wrapper itself
    expect(decoded.match(/\(/g)).toHaveLength(1);
    expect(decoded.match(/\)/g)).toHaveLength(1);
    const itemUrl = calls.find((c) => c.url.includes('/rest/v1/items'))!.url;
    expect(decodedQuery(itemUrl)).toContain('title.ilike.*Bin LPL*');
  });

  it('returns empty results without a request for an all-filter-chars query', async () => {
    const { impl, calls } = recordingFetch(byTable([], []));
    const out = await searchAtlas(' , () * " {} \\', { fetchImpl: impl, env: ENV });
    expect(calls).toHaveLength(0);
    expect(out).toEqual({ shelves: [], items: [] });
  });

  it('throws on HTTP errors with status and short detail', async () => {
    const { impl, calls } = recordingFetch((url) =>
      url.includes('/rest/v1/shelves') ? { error: 'row-level security blocked this', status: 403 } : []);
    await expect(searchAtlas('Bin', { fetchImpl: impl, env: ENV })).rejects.toThrow(/GET shelves .* HTTP 403/);
    expect(calls).toHaveLength(2); // both tables fire in parallel; the shelves one fails
  });

  it('throws when env is missing and never echoes the key', async () => {
    await expect(searchAtlas('Bin', { fetchImpl: recordingFetch(byTable([], [])).impl, env: {} }))
      .rejects.toThrow(/SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY/);
    try {
      await searchAtlas('Bin', {
        fetchImpl: recordingFetch(byTable([], [])).impl,
        env: { SUPABASE_URL },
      });
      expect.unreachable('should have thrown');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toContain('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
      expect(message).not.toContain(SERVICE_KEY);
    }
  });
});

describe('sanitizeAtlasQuery', () => {
  it('strips filter syntax characters and trims', () => {
    expect(sanitizeAtlasQuery('  Bin, (LPL)*"{\\} ')).toBe('Bin LPL');
    expect(sanitizeAtlasQuery('***')).toBe('');
  });
});

describe('getShelvesByIds', () => {
  it('fetches id,slug with an in.(...) filter and dedupes ids', async () => {
    const { impl, calls } = recordingFetch(() => [{ id: SHELF.id, slug: SHELF.slug }]);
    const out = await getShelvesByIds([SHELF.id, SHELF.id, ''], { fetchImpl: impl, env: ENV });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.headers.get('Accept-Profile')).toBe('atlas');
    expect(decodedQuery(calls[0]!.url)).toBe(`select=id,slug&id=in.(${SHELF.id})`);
    expect(out).toEqual([{ id: SHELF.id, slug: SHELF.slug }]);
  });

  it('returns empty without a request for an empty id list', async () => {
    const { impl, calls } = recordingFetch(() => []);
    const out = await getShelvesByIds([], { fetchImpl: impl, env: ENV });
    expect(calls).toHaveLength(0);
    expect(out).toEqual([]);
  });
});