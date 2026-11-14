import { useCallback } from 'react';
import { fetchLatestUpdates } from './latest-updates.api';
import { LATEST_UPDATES_MOCK, presentLatestUpdates, type LatestUpdatesPresentation } from './latest-updates';
import { useFeedSection } from './use-feed-section';

/**
 * Feed section for GET /latest-updates. Same load, queue and retry shape as
 * the other Feed sections. `mocksEnabled` defaults to the env flag and is
 * only overridden by tests.
 */
export function useLatestUpdates(active = true, mocksEnabled = LATEST_UPDATES_MOCK) {
  const fetcher = useCallback((signal: AbortSignal) => fetchLatestUpdates({ signal }), []);
  const section = useFeedSection(fetcher, active);
  const view: LatestUpdatesPresentation = presentLatestUpdates(section.data, section.error, mocksEnabled);
  const retry = useCallback(() => section.load(), [section.load]);
  return {
    view,
    retry,
    load: section.load,
    apply: section.apply,
    pending: section.pending !== null,
  };
}
