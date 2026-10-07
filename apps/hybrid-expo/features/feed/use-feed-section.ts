import { useCallback, useEffect, useRef, useState } from 'react';
import { hasChanged } from './feed-state';

// Each module resolves independently. Polls queue content; explicit refresh/retry applies it.
export function useFeedSection<T>(fetcher: (signal: AbortSignal) => Promise<T>, active = true) {
  const [data, setData] = useState<T | null>(null);
  const [pending, setPending] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const value = useRef<T | null>(null);
  const request = useRef<AbortController | null>(null);

  const load = useCallback(async (queue = false) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    if (!queue) setLoading(true);
    try {
      const next = await fetcher(controller.signal);
      if (controller.signal.aborted) return;
      setError(null);
      if (queue && value.current !== null) {
        setPending(hasChanged(value.current, next) ? next : null);
      } else {
        value.current = next;
        setData(next);
        setPending(null);
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Unable to load this section.');
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [fetcher]);

  useEffect(() => {
    if (active && value.current === null) void load();
    if (!active) setLoading(false);
    return () => { request.current?.abort(); };
  }, [active, load]);

  const apply = useCallback(() => {
    if (pending !== null) {
      value.current = pending;
      setData(pending);
      setPending(null);
    }
  }, [pending]);

  return { data, pending, loading, error, load, apply };
}
