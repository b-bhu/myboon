import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { readSectionCache, writeSectionCache } from './feed-section-cache';

export interface FeedSectionOptions {
  /**
   * Versioned AsyncStorage key under which this section's last successful
   * payload is saved (issue #416). Persistence is opt-in: only the Feed Home
   * sections pass a key, every other `useFeedSection` caller stays memory-only.
   */
  storageKey?: string;
  /**
   * True while a press is down inside the section's wrapper. A fresh result
   * that arrives while a finger is down is then held until `release()` is
   * called, so the tile or card under the finger does not jump out from
   * under it (#797: polls are silent, so the hold is their only guard).
   */
  holdRef?: RefObject<boolean>;
}

// Every fetch applies on arrival; the five-minute polls are silent and the
// only deferral is the press hold, applied on `release()` (#797).
export function useFeedSection<T>(fetcher: (signal: AbortSignal) => Promise<T>, active = true, options: FeedSectionOptions = {}) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const value = useRef<T | null>(null);
  const request = useRef<AbortController | null>(null);
  const { storageKey, holdRef } = options;
  const hydrated = useRef(false); // the on-device copy is read at most once per mount
  const firstFetchStarted = useRef(false); // the first fresh fetch runs once, saved copy or not
  const held = useRef<T | null>(null); // a fresh result deferred while a press is down

  const load = useCallback(async (silent = false) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    if (!silent) setLoading(true);
    try {
      const next = await fetcher(controller.signal);
      if (controller.signal.aborted) return;
      setError(null);
      // Persist every successful result, including an empty one; a thrown
      // fetch never reaches here, and a failed write never breaks the UI.
      void writeSectionCache(storageKey, next);
      if (holdRef?.current === true && value.current !== null) {
        // With data on screen, a result arriving under a finger waits for the
        // press to end; `release()` swaps it in.
        held.current = next;
      } else {
        held.current = null;
        value.current = next;
        setData(next);
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Unable to load this section.');
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [fetcher, storageKey, holdRef]);

  useEffect(() => {
    if (storageKey && !hydrated.current) {
      hydrated.current = true;
      let alive = true;
      void readSectionCache<T>(storageKey).then((saved) => {
        // Set the saved copy as data as soon as the read returns (loading has
        // stayed false throughout, so no placeholder flashes), then fetch fresh.
        if (!alive) return;
        if (saved !== null && value.current === null) {
          value.current = saved;
          setData(saved);
        }
        if (active && !firstFetchStarted.current) {
          firstFetchStarted.current = true;
          void load();
        }
      });
      return () => { alive = false; request.current?.abort(); };
    }
    if (active) {
      if (storageKey) {
        // A hydrated saved copy must not skip the first network fetch, and that
        // first fetch runs with silent=false so it swaps in. Later activations
        // of the same mount stay unchanged: polling and pull-to-refresh refresh.
        if (!firstFetchStarted.current) {
          firstFetchStarted.current = true;
          void load();
        }
      } else if (value.current === null) {
        void load();
      }
    }
    if (!active) setLoading(false);
    return () => { request.current?.abort(); };
  }, [active, load, storageKey]);

  /** Applies a fresh result that was held while a press was down in this section. */
  const release = useCallback(() => {
    if (held.current === null) return;
    const next = held.current;
    held.current = null;
    value.current = next;
    setData(next);
  }, []);

  return { data, loading, error, load, release };
}
