/**
 * #690 Hyperliquid live market list, fetched once and cached in memory for 10 minutes.
 * Two POSTs to the public /info endpoint: core ("meta") and builder-deployed ("meta", dex "xyz"),
 * 10 s timeout each. Returns the exact symbols the API returns ('BTC', 'kPEPE', 'xyz:CL') where
 * isDelisted is not true — names are used exactly as returned, never copied to another format.
 * If either call fails it throws: the markets pass is skipped this run, never fails the entity run.
 */

export const HYPERLIQUID_INFO_URL = 'https://api.hyperliquid.xyz/info';
export const HYPERLIQUID_TIMEOUT_MS = 10_000;
export const HYPERLIQUID_CACHE_MS = 10 * 60_000;

type MetaReply = { universe?: Array<{ name?: unknown; isDelisted?: unknown }> };

/** In-process cache; two dex POSTs per 10 minutes, no matter how many entities the pass checks. */
let cache: { at: number; symbols: string[] } | null = null;

/** Test-only: forget the in-memory cache so the next fetchHyperliquidMarkets calls the API again. */
export function resetHyperliquidCacheForTests(): void {
  cache = null;
}

async function fetchDexNames(fetchImpl: typeof fetch, dex: string): Promise<string[]> {
  const res = await fetchImpl(HYPERLIQUID_INFO_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(dex === '' ? { type: 'meta' } : { type: 'meta', dex }),
    signal: AbortSignal.timeout(HYPERLIQUID_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`hyperliquid list HTTP ${res.status} (${dex === '' ? 'core' : dex})`);
  const root = (await res.json()) as MetaReply;
  if (!Array.isArray(root.universe)) throw new Error(`hyperliquid list has no universe array (${dex === '' ? 'core' : dex})`);
  const names: string[] = [];
  for (const u of root.universe) {
    if (u && typeof u.name === 'string' && u.name !== '' && u.isDelisted !== true) names.push(u.name);
  }
  return names;
}

export async function fetchHyperliquidMarkets(
  o: { fetchImpl?: typeof fetch; now?: () => number } = {},
): Promise<ReadonlySet<string>> {
  const fetchImpl = o.fetchImpl ?? fetch;
  const now = o.now ?? Date.now;
  const fresh = cache;
  if (fresh && now() - fresh.at < HYPERLIQUID_CACHE_MS) return new Set(fresh.symbols);
  const core = await fetchDexNames(fetchImpl, '');
  const xyz = await fetchDexNames(fetchImpl, 'xyz');
  const symbols = [...core, ...xyz];
  cache = { at: now(), symbols };
  return new Set(symbols);
}
