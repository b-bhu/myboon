/**
 * #391 the Ollama quota guard: readOllamaQuota parses both documented /api/balance
 * shapes (legacy weekly.remaining_percent, current balance_usd/allowance_usd) without
 * ever putting the key in an error; createQuotaGuard fails closed on a low remaining
 * percent or an unreliable read, and caches the last reading for minIntervalMs so the
 * catch-up loop stays far below ollama.com's documented 10 requests/minute limit.
 */
import { describe, expect, it } from 'vitest';

import { createQuotaGuard, readOllamaQuota, type QuotaReading } from './ollama-quota.js';

const KEY = 'test-ollama-key';

const reading = (remainingPercent: number, source: QuotaReading['source'] = 'weekly'): QuotaReading => ({ source, remainingPercent });

function fakeFetch(status: number, body: unknown): { impl: typeof fetch; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('readOllamaQuota', () => {
  it('a legacy plan: weekly.remaining_percent -> source weekly (and hits /api/balance with the bearer key)', async () => {
    const f = fakeFetch(200, {
      included: { weekly: { remaining_percent: 40, resets_at: '2026-11-02T00:00:00Z' }, session: { remaining_percent: 90 } },
    });
    expect(await readOllamaQuota(KEY, f.impl)).toEqual(reading(40));
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].url).toBe('https://ollama.com/api/balance');
    expect((f.calls[0].init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
  });

  it('remaining_percent 0 (exhausted) is still a reliable reading', async () => {
    const f = fakeFetch(200, { included: { weekly: { remaining_percent: 0, resets_at: '2026-11-02T00:00:00Z' } } });
    expect(await readOllamaQuota(KEY, f.impl)).toEqual(reading(0));
  });

  it('a current plan: balance_usd/allowance_usd -> source monthly_balance with balance/allowance percent', async () => {
    const f = fakeFetch(200, { included: { balance_usd: 12.5, allowance_usd: 50, period: 'monthly' } });
    expect(await readOllamaQuota(KEY, f.impl)).toEqual(reading(25, 'monthly_balance'));
  });

  it('a fractional monthly ratio is computed without float noise', async () => {
    const f = fakeFetch(200, { included: { balance_usd: 3, allowance_usd: 7, period: 'monthly' } });
    const r = await readOllamaQuota(KEY, f.impl);
    expect(r.source).toBe('monthly_balance');
    expect(r.remainingPercent).toBeCloseTo(42.8571, 3);
  });

  it('a non-2xx response throws naming the status', async () => {
    const f = fakeFetch(500, { error: 'boom' });
    await expect(readOllamaQuota(KEY, f.impl)).rejects.toThrow('ollama quota: no reliable remaining signal (HTTP 500)');
  });

  it('a 2xx body in neither documented shape throws on the shape', async () => {
    for (const body of [{}, { included: {} }, { included: { weekly: {}, balance_usd: 12.5 } }, { included: { balance_usd: 12.5, allowance_usd: 0 } }]) {
      const f = fakeFetch(200, body);
      await expect(readOllamaQuota(KEY, f.impl)).rejects.toThrow('ollama quota: no reliable remaining signal (unexpected response shape)');
    }
  });

  it('a network error fails with the key redacted', async () => {
    const boom = (async () => {
      throw new Error(`network down for ${KEY}`);
    }) as unknown as typeof fetch;
    await expect(readOllamaQuota(KEY, boom)).rejects.toThrow('network error: network down for [redacted]');
  });
});

describe('createQuotaGuard', () => {
  it('ok at 40 and exactly 15 (the default minPercent), stops at 14', async () => {
    expect(await createQuotaGuard({ read: async () => reading(40) }).check())
      .toEqual({ ok: true, reading: reading(40) });
    expect((await createQuotaGuard({ read: async () => reading(15) }).check()).ok).toBe(true);
    const stopped = await createQuotaGuard({ read: async () => reading(14) }).check();
    expect(stopped).toMatchObject({ ok: false, reading: reading(14) });
    expect(stopped.reason).toContain('14');
    expect(stopped.reason).toContain('15');
  });

  it('a monthly_balance reading passes its source through the verdict', async () => {
    expect(await createQuotaGuard({ read: async () => reading(80, 'monthly_balance') }).check())
      .toEqual({ ok: true, reading: reading(80, 'monthly_balance') });
  });

  it('a thrown read fails closed with a reason and no reading', async () => {
    const g = createQuotaGuard({
      read: async () => {
        throw new Error('ollama quota: no reliable remaining signal (HTTP 500)');
      },
    });
    const c = await g.check();
    expect(c.ok).toBe(false);
    expect(c.reading).toBeUndefined();
    expect(c.reason).toContain('fail closed');
    expect(c.reason).toContain('HTTP 500');
  });

  it('caches the last reading for minIntervalMs: two checks within the interval read once, a stale cache reads again', async () => {
    let nowMs = 1_000;
    let reads = 0;
    let value = 50;
    const g = createQuotaGuard({
      read: async () => {
        reads += 1;
        return reading(value);
      },
      now: () => nowMs,
    });
    const first = await g.check();
    expect(first).toEqual({ ok: true, reading: reading(50) });
    // Second check inside the interval: served from the cache, the reader is not called again.
    expect(await g.check()).toEqual(first);
    expect(reads).toBe(1);
    // Exactly at the interval boundary the cache is stale and it reads again.
    nowMs += 60_000;
    expect((await g.check()).ok).toBe(true);
    expect(reads).toBe(2);
    // A fresh read that dropped below the minimum changes the verdict after the cache expires.
    value = 10;
    nowMs += 60_000;
    const last = await g.check();
    expect(last.ok).toBe(false);
    expect(last.reading).toEqual(reading(10));
    expect(reads).toBe(3);
  });

  it('within the cache interval the verdict is the cached one, even if the reader would now stop', async () => {
    let nowMs = 0;
    let value = 16;
    const g = createQuotaGuard({
      read: async () => reading(value),
      now: () => nowMs,
    });
    expect((await g.check()).ok).toBe(true);
    value = 5;
    nowMs += 10_000;
    expect((await g.check()).ok).toBe(true);
  });
});