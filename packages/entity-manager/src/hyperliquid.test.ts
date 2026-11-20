/** #690 Hyperliquid live list with a fake fetch (no network): shapes, cache and failure. */
import { beforeEach, describe, expect, it } from 'vitest';

import { fetchHyperliquidMarkets, HYPERLIQUID_CACHE_MS, HYPERLIQUID_INFO_URL, resetHyperliquidCacheForTests } from './hyperliquid.js';

type Meta = { universe: Array<{ name: string; isDelisted?: boolean }> };
type Call = { url: string; init: RequestInit };

/** A fetch whose nth POST (0-based) answers `respond(n)`. */
function fakeFetch(respond: (callNo: number) => Meta | Error) {
  const calls: Call[] = [];
  const impl = (async (url: unknown, init?: RequestInit) => {
    const r = respond(calls.length);
    calls.push({ url: String(url), init: init ?? {} });
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fetch: impl, calls };
}

const META = (universe: Meta['universe']): Meta => ({ universe });

beforeEach(() => {
  resetHyperliquidCacheForTests();
});

describe('#690 fetchHyperliquidMarkets', () => {
  it('merges both dexes, excludes delisted names and uses the symbols exactly as returned', async () => {
    const { fetch, calls } = fakeFetch((n) =>
      n === 0
        ? META([{ name: 'BTC' }, { name: 'MATIC', isDelisted: true }, { name: 'kPEPE', isDelisted: false }])
        : META([{ name: 'xyz:CL' }, { name: 'xyz:GONE', isDelisted: true }, { name: 'xyz:TSLA' }]),
    );
    const symbols = await fetchHyperliquidMarkets({ fetchImpl: fetch });
    expect([...symbols]).toEqual(['BTC', 'kPEPE', 'xyz:CL', 'xyz:TSLA']);
    expect(symbols.has('MATIC')).toBe(false);
    expect(symbols.has('xyz:GONE')).toBe(false);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ url: HYPERLIQUID_INFO_URL, init: { method: 'POST' } });
    expect(JSON.parse((calls[0]!.init.body as string) ?? '{}')).toEqual({ type: 'meta' });
    expect(JSON.parse((calls[1]!.init.body as string) ?? '{}')).toEqual({ type: 'meta', dex: 'xyz' });
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('a second call within 10 minutes uses the cache (no new POSTs), one past the TTL refetches', async () => {
    const { fetch, calls } = fakeFetch((n) => (n % 2 === 0 ? META([{ name: 'BTC' }]) : META([{ name: 'xyz:CL' }])));
    let now = 1_000;
    const nowFn = () => now;
    await fetchHyperliquidMarkets({ fetchImpl: fetch, now: nowFn });
    expect(await fetchHyperliquidMarkets({ fetchImpl: fetch, now: nowFn })).toEqual(new Set(['BTC', 'xyz:CL']));
    expect(calls).toHaveLength(2);
    now = 1_000 + HYPERLIQUID_CACHE_MS - 1;
    await fetchHyperliquidMarkets({ fetchImpl: fetch, now: nowFn });
    expect(calls).toHaveLength(2);
    now = 1_000 + HYPERLIQUID_CACHE_MS;
    await fetchHyperliquidMarkets({ fetchImpl: fetch, now: nowFn });
    expect(calls).toHaveLength(4);
  });

  it('a failing dex throws and nothing is cached, so the next call fetches again', async () => {
    const { fetch, calls } = fakeFetch((n) => (n === 1 ? new Error('hyperliquid down') : n === 3 ? META([{ name: 'xyz:CL' }]) : META([{ name: 'BTC' }])));
    await expect(fetchHyperliquidMarkets({ fetchImpl: fetch })).rejects.toThrow('hyperliquid down');
    expect(await fetchHyperliquidMarkets({ fetchImpl: fetch })).toEqual(new Set(['BTC', 'xyz:CL']));
    expect(calls).toHaveLength(4);
  });

  it('a failed HTTP status throws with the dex named', async () => {
    const boom = (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch;
    await expect(fetchHyperliquidMarkets({ fetchImpl: boom })).rejects.toThrow(/HTTP 503 \(core\)/);
  });

  it('a reply without a universe array throws', async () => {
    const { fetch } = fakeFetch(() => ({}) as unknown as Meta);
    await expect(fetchHyperliquidMarkets({ fetchImpl: fetch })).rejects.toThrow('no universe array');
  });
});
