import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchTokenHeatmap } from './token-heatmap.api';
import type { HeatmapInterval, TokenHeatmapResult } from './token-heatmap.types';

type State = { interval: HeatmapInterval; data: TokenHeatmapResult | null; loading: boolean; error: string | null };

export function useTokenHeatmap(interval: HeatmapInterval, active = true, fetcher = fetchTokenHeatmap) {
  const [state, setState] = useState<State>({ interval, data: null, loading: active, error: null });
  const cache = useRef(new Map<HeatmapInterval, TokenHeatmapResult>());
  const request = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    if (!active) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setState({ interval, data: cache.current.get(interval) ?? null, loading: true, error: null });
    try {
      const data = await fetcher(interval, controller.signal);
      if (controller.signal.aborted) return;
      cache.current.set(interval, data);
      setState({ interval, data, loading: false, error: null });
    } catch (cause) {
      if (!controller.signal.aborted) setState({ interval, data: cache.current.get(interval) ?? null, loading: false,
        error: cause instanceof Error ? cause.message : 'Token heatmap could not be loaded. Try again.' });
    }
  }, [active, fetcher, interval]);

  useEffect(() => {
    if (active) void load();
    return () => { request.current?.abort(); };
  }, [active, load]);

  // Never relabel a previous interval's data during the render before its effect runs.
  const current = state.interval === interval ? state : { interval, data: null, loading: active, error: null };
  return { ...current, loading: active && current.loading, load };
}
