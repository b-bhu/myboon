/**
 * Client for the token identity service (`GET/POST /tokens/resolve`).
 *
 * One place every screen asks "what is this token" instead of six. See
 * docs/modules/wallet/PRDs/2026_08_11_token_identity_and_venue_adapters_PRD.md.
 *
 * Contract (frozen — server side is being built against this shape):
 * - GET  /tokens/resolve?refs=<comma-separated>   (<=100 refs)
 * - POST /tokens/resolve { refs: string[] }        (<=500 refs)
 * - 200 { identities: TokenIdentity[] } — one entry per input ref, in input
 *   order, and it NEVER 4xx/5xx just because a ref is unresolved. Fallback
 *   logic must trigger on empty/null fields, never on HTTP status.
 *
 * Ref grammar:
 * - `mint:<base58>` for an SPL mint
 * - `perp:<symbol>` for a perp market symbol, with or without the `-PERP`
 *   suffix, case preserved (e.g. `perp:kPEPE-PERP`)
 *
 * Never blocks a list. `useTokenIdentities` and `resolveTokenIdentities`
 * both return immediately with whatever is already cached (possibly an empty
 * map) and let callers re-render when identities land in the background.
 */

import { useEffect, useMemo, useSyncExternalStore } from 'react';

import { fetchWithTimeout, resolveApiBaseUrl } from '@/lib/api';

// The interface and the ref builders live in `token-identity.core.ts` — a
// pure, import-free module — so the venue row mappers can use them under
// `tsx --test` without dragging react-native into the graph. Re-exported here
// so existing callers keep importing from one place.
export type { TokenIdentity } from '@/lib/token-identity.core';
export { mintRef, perpRef } from '@/lib/token-identity.core';

import type { TokenIdentity } from '@/lib/token-identity.core';
import { TokenIdentityStore } from '@/lib/token-identity.store';

const GET_BATCH_LIMIT = 15;

// There is deliberately NO client-side kill switch here. Acceptance criterion 9
// is "the entire Tokens integration sits behind ONE feature flag and ONE env
// var" — that flag is TOKEN_IDENTITY_ENABLED on the server. A second client
// knob could disagree with the server's, which is the exact failure this
// criterion rules out. With the server flag off, /tokens/resolve still answers
// well-formed identities with null icons, and every consumer already degrades
// to venue-supplied icons and the letter box, so nothing here needs to branch.

const identityStore = new TokenIdentityStore(fetchBatch);

function unresolvedIdentity(ref: string): TokenIdentity {
  const bareSymbol = ref.startsWith('perp:')
    ? ref.slice('perp:'.length).replace(/-PERP$/i, '')
    : ref.startsWith('mint:')
      ? ref.slice('mint:'.length)
      : ref;
  const letter = bareSymbol.trim().charAt(0).toUpperCase() || '?';
  return {
    key: ref,
    assetId: null,
    symbol: bareSymbol,
    name: bareSymbol,
    iconUrl: null,
    decimals: null,
    mint: ref.startsWith('mint:') ? ref.slice('mint:'.length) : null,
    verified: false,
    category: 'unknown',
    fallbackLetter: letter,
    source: 'static',
  };
}

async function fetchBatch(refs: readonly string[]): Promise<readonly TokenIdentity[]> {
  const base = resolveApiBaseUrl();
  try {
    let identities: TokenIdentity[];
    if (refs.length <= GET_BATCH_LIMIT) {
      const url = `${base}/tokens/resolve?refs=${encodeURIComponent(refs.join(','))}`;
      const response = await fetchWithTimeout(url, { cache: 'no-store' });
      if (!response.ok) throw new Error(`token identity resolve failed (${response.status})`);
      const payload = (await response.json()) as { identities: TokenIdentity[] };
      identities = payload.identities ?? [];
    } else {
      const response = await fetchWithTimeout(`${base}/tokens/resolve`, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refs }),
      });
      if (!response.ok) throw new Error(`token identity resolve failed (${response.status})`);
      const payload = (await response.json()) as { identities: TokenIdentity[] };
      identities = payload.identities ?? [];
    }

    if (!Array.isArray(identities)) throw new Error('Invalid token identity response');
    return identities;
  } catch (error) {
    throw error;
  }
}

/**
 * Warm the whole identity cache from `GET /tokens/catalog` in one request.
 *
 * Call this once, early — the app opens on the feed and markets sit below the
 * fold, so there is idle time to fill this before any row needs it. After it
 * resolves, `resolveTokenIdentities` is a pure cache read for every token the
 * app knows about, so no market row ever waits on the network for its icon.
 *
 * The HTTP cache uses max-age and ETag. The shared in-memory store also
 * expires missing icons, and notifies mounted screens when the catalog lands.
 *
 * Never throws. A failure leaves the cache as it was and rows fall back to the
 * venue icon or the letter box, exactly as they do before this resolves.
 */
export async function warmTokenIdentityCatalog(): Promise<number> {
  try {
    const response = await fetchWithTimeout(`${resolveApiBaseUrl()}/tokens/catalog`);
    if (!response.ok) return 0;
    const payload = (await response.json()) as { identities?: TokenIdentity[] };
    const identities = payload.identities ?? [];
    if (!Array.isArray(identities)) return 0;
    identityStore.seed(identities);
    return identities.length;
  } catch {
    return 0;
  }
}

/**
 * Resolve a set of refs to their identities. Never rejects — a fully failed
 * fetch just leaves those refs missing from the returned map, and callers
 * are expected to fall back to a computed letter/box rather than block.
 *
 * Results already cached (positively or within the negative-cache window)
 * are returned immediately without a new request. Concurrent calls for the
 * same ref share one in-flight request.
 */
export async function resolveTokenIdentities(
  refs: readonly string[],
  options: { force?: boolean } = {},
): Promise<ReadonlyMap<string, TokenIdentity>> {
  return identityStore.resolve(refs, options);
}

/** Resolve an origin-relative icon URL (e.g. `/tokens/icon/sol`) against the API base. */
export function tokenIconUrl(iconUrl: string | null | undefined): string | null {
  if (!iconUrl) return null;
  if (/^https?:\/\//i.test(iconUrl)) return iconUrl;
  const base = resolveApiBaseUrl();
  return `${base}${iconUrl.startsWith('/') ? '' : '/'}${iconUrl}`;
}

/**
 * React hook wrapper around `resolveTokenIdentities`. Renders immediately
 * with whatever is cached (often empty) and re-renders once the fetch
 * lands. Never throws into the render; callers should treat a missing key
 * as "render the fallback".
 */
export function useTokenIdentities(refs: readonly string[]): ReadonlyMap<string, TokenIdentity> {
  const refsKey = refs.join(',');
  const revision = useSyncExternalStore(identityStore.subscribe, identityStore.getRevision, identityStore.getRevision);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- refsKey is the stable identity of refs
  const stableRefs = useMemo(() => refs, [refsKey]);

  useEffect(() => {
    if (stableRefs.length === 0) return;
    void resolveTokenIdentities(stableRefs);
  }, [stableRefs]);

  return useMemo(() => {
    void revision;
    return identityStore.snapshot(stableRefs);
  }, [revision, stableRefs]);
}

/** Compute the same server-style fallback locally, for immediate (pre-fetch) rendering. */
export function fallbackIdentity(ref: string): TokenIdentity {
  return unresolvedIdentity(ref);
}
