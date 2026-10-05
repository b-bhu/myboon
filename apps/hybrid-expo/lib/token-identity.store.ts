import type { TokenIdentity } from './token-identity.core';

const RESOLVED_CACHE_MS = 10 * 60_000;
const MISSING_CACHE_MS = 30_000;
const BATCH_LIMIT = 500;

/** Shared between mounted screens; a cache write updates every subscriber. */
export class TokenIdentityStore {
  private readonly cache = new Map<string, { identity: TokenIdentity; expiresAt: number }>();
  private readonly failures = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly listeners = new Set<() => void>();
  private revision = 0;

  constructor(
    private readonly load: (refs: readonly string[]) => Promise<readonly TokenIdentity[]>,
    private readonly now: () => number = Date.now,
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getRevision = (): number => this.revision;

  snapshot(refs: readonly string[]): ReadonlyMap<string, TokenIdentity> {
    const result = new Map<string, TokenIdentity>();
    for (const ref of refs) {
      const cached = this.cache.get(ref);
      if (cached) result.set(ref, cached.identity);
    }
    return result;
  }

  seed(identities: readonly TokenIdentity[]): void {
    let changed = false;
    const now = this.now();
    for (const identity of identities) {
      const cached = this.cache.get(identity.key);
      // A late catalog fallback must not erase an icon resolved by a screen.
      const next = cached?.identity.iconUrl && !identity.iconUrl
        ? { ...identity, iconUrl: cached.identity.iconUrl }
        : identity;
      if (!cached || (Object.keys(next) as (keyof TokenIdentity)[])
        .some((key) => cached.identity[key] !== next[key])) changed = true;
      this.cache.set(next.key, {
        identity: next,
        expiresAt: now + (next.iconUrl ? RESOLVED_CACHE_MS : MISSING_CACHE_MS),
      });
      this.failures.delete(next.key);
    }
    if (changed) {
      this.revision += 1;
      this.listeners.forEach((listener) => listener());
    }
  }

  async resolve(
    refs: readonly string[],
    { force = false }: { force?: boolean } = {},
  ): Promise<ReadonlyMap<string, TokenIdentity>> {
    const uniqueRefs = Array.from(new Set(refs));
    const waits = new Set<Promise<void>>();
    const toFetch: string[] = [];
    const now = this.now();
    for (const ref of uniqueRefs) {
      const pending = this.inFlight.get(ref);
      if (pending) { waits.add(pending); continue; }
      if (!force && ((this.cache.get(ref)?.expiresAt ?? 0) > now
        || (this.failures.get(ref) ?? 0) > now)) continue;
      toFetch.push(ref);
    }

    for (let offset = 0; offset < toFetch.length; offset += BATCH_LIMIT) {
      const batch = toFetch.slice(offset, offset + BATCH_LIMIT);
      const pending = Promise.resolve().then(() => this.load(batch))
        .then((identities) => {
          this.seed(identities);
          const returned = new Set(identities.map((identity) => identity.key));
          for (const ref of batch) {
            if (!returned.has(ref)) this.failures.set(ref, this.now() + MISSING_CACHE_MS);
          }
        })
        .catch(() => {
          const expiresAt = this.now() + MISSING_CACHE_MS;
          batch.forEach((ref) => this.failures.set(ref, expiresAt));
        })
        .finally(() => {
          for (const ref of batch) {
            if (this.inFlight.get(ref) === pending) this.inFlight.delete(ref);
          }
        });
      batch.forEach((ref) => this.inFlight.set(ref, pending));
      waits.add(pending);
    }
    await Promise.all(waits);
    return this.snapshot(uniqueRefs);
  }
}
