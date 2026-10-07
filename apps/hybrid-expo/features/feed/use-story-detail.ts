import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchStoryDetail } from './stories.api';
import type { StoryDetail } from './feed.types';

export function useStoryDetail(storySlug: string | undefined) {
  const [detail, setDetail] = useState<StoryDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState(false);
  const [retryVersion, setRetryVersion] = useState(0);
  const generation = useRef(0);
  const earlierRequest = useRef<AbortController | null>(null);

  useEffect(() => {
    const currentGeneration = ++generation.current;
    const controller = new AbortController();
    earlierRequest.current?.abort();
    earlierRequest.current = null;
    setDetail(null);
    setError(false);
    setLoadMoreError(false);
    setLoadingMore(false);
    setLoading(Boolean(storySlug));
    if (storySlug) {
      void fetchStoryDetail(storySlug, 20, 0, { signal: controller.signal }).then((result) => {
        if (!controller.signal.aborted && currentGeneration === generation.current) setDetail(result);
      }).catch(() => {
        if (!controller.signal.aborted && currentGeneration === generation.current) setError(true);
      }).finally(() => {
        if (!controller.signal.aborted && currentGeneration === generation.current) setLoading(false);
      });
    }
    return () => { generation.current += 1; controller.abort(); earlierRequest.current?.abort(); };
  }, [storySlug, retryVersion]);

  const loadEarlierMemories = useCallback(async () => {
    if (!storySlug || !detail?.pagination.hasMore || detail.pagination.nextOffset === null || earlierRequest.current) return;
    const controller = new AbortController();
    earlierRequest.current = controller;
    const currentGeneration = generation.current;
    setLoadingMore(true);
    setLoadMoreError(false);
    try {
      const next = await fetchStoryDetail(storySlug, 20, detail.pagination.nextOffset, { signal: controller.signal });
      if (controller.signal.aborted || currentGeneration !== generation.current) return;
      setDetail((current) => current?.story.storySlug === storySlug ? {
        story: next.story, events: [...current.events, ...next.events], pagination: next.pagination,
      } : current);
    } catch {
      if (!controller.signal.aborted && currentGeneration === generation.current) setLoadMoreError(true);
    } finally {
      if (currentGeneration === generation.current && earlierRequest.current === controller) {
        earlierRequest.current = null;
        setLoadingMore(false);
      }
    }
  }, [storySlug, detail]);
  return { detail, loading, error, loadingMore, loadMoreError, loadEarlierMemories,
    retry: () => setRetryVersion((value) => value + 1) };
}
