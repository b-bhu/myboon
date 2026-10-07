import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchFeedItems } from './feed.api';
import type { FeedItem } from './feed.types';
import { hasChanged, mergeReports } from './feed-state';

export const REPORT_PAGE_SIZE = 20;
export function useReportPages() {
  const [items, setItems] = useState<FeedItem[]>([]);
  const [pending, setPending] = useState<FeedItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [olderError, setOlderError] = useState<string | null>(null);
  const firstPage = useRef<FeedItem[] | null>(null);
  const offset = useRef(0);
  const hasMore = useRef(true);
  const generation = useRef(0);
  const headRequest = useRef<AbortController | null>(null);
  const olderRequest = useRef<AbortController | null>(null);

  const applyPage = useCallback((page: FeedItem[]) => {
    generation.current += 1;
    olderRequest.current?.abort();
    olderRequest.current = null;
    setLoadingMore(false);
    firstPage.current = page;
    // Rebase the cursor at the newly read head. Older loaded rows remain visible,
    // and later offset pages traverse/deduplicate overlaps before extending the tail.
    offset.current = page.length;
    hasMore.current = page.length === REPORT_PAGE_SIZE;
    setItems((current) => mergeReports(current, page));
    setPending(null);
    setOlderError(null);
  }, []);

  const refresh = useCallback(async (queue = false) => {
    headRequest.current?.abort();
    const controller = new AbortController();
    headRequest.current = controller;
    if (!queue) setLoading(true);
    try {
      const page = await fetchFeedItems(REPORT_PAGE_SIZE, 0, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setError(null);
      if (queue && firstPage.current !== null) {
        setPending(hasChanged(firstPage.current, page) ? page : null);
      } else applyPage(page);
    } catch {
      if (!controller.signal.aborted) setError('Latest updates could not be refreshed.');
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [applyPage]);

  const loadMore = useCallback(async () => {
    if (olderRequest.current || !hasMore.current || !firstPage.current) return;
    const controller = new AbortController();
    olderRequest.current = controller;
    const requestGeneration = generation.current;
    setLoadingMore(true);
    setOlderError(null);
    try {
      const page = await fetchFeedItems(REPORT_PAGE_SIZE, offset.current, { signal: controller.signal });
      if (controller.signal.aborted || requestGeneration !== generation.current) return;
      offset.current += page.length;
      hasMore.current = page.length === REPORT_PAGE_SIZE;
      setItems((current) => mergeReports(current, page));
    } catch {
      if (!controller.signal.aborted) setOlderError('Older updates could not be loaded.');
    } finally {
      if (olderRequest.current === controller) {
        olderRequest.current = null;
        setLoadingMore(false);
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
    return () => { headRequest.current?.abort(); olderRequest.current?.abort(); };
  }, [refresh]);
  return { items, pending, loading, loadingMore, error, olderError, refresh, loadMore,
    apply: () => { if (pending !== null) applyPage(pending); } };
}
