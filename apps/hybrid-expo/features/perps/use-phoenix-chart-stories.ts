import { useEffect, useMemo, useState } from 'react';
import { fetchStoryDetail } from '@/features/feed/stories.api';
import type { StoryEvent, StorySummary } from '@/features/feed/feed.types';
import {
  collectPhoenixChartStoryPages,
  PHOENIX_CHART_STORY_PAGE_SIZE,
  phoenixStorySlugForSymbol,
} from '@/features/perps/phoenix.chart-stories';

export type PhoenixChartStoriesStatus = 'not-applicable' | 'loading' | 'ready' | 'error';

interface PhoenixChartStoriesState {
  readonly status: PhoenixChartStoriesStatus;
  readonly storySlug: string | null;
  readonly story: StorySummary | null;
  readonly events: readonly StoryEvent[];
}

const EMPTY_EVENTS: readonly StoryEvent[] = [];

/** Loads product Story data independently so a Story failure never blocks market data. */
export function usePhoenixChartStories(symbol: string): PhoenixChartStoriesState {
  const storySlug = useMemo(() => phoenixStorySlugForSymbol(symbol), [symbol]);
  const [state, setState] = useState<PhoenixChartStoriesState>(() => ({
    status: storySlug ? 'loading' : 'not-applicable',
    storySlug,
    story: null,
    events: EMPTY_EVENTS,
  }));

  useEffect(() => {
    if (!storySlug) {
      setState({
        status: 'not-applicable',
        storySlug: null,
        story: null,
        events: EMPTY_EVENTS,
      });
      return undefined;
    }

    const controller = new AbortController();
    setState({ status: 'loading', storySlug, story: null, events: EMPTY_EVENTS });

    void collectPhoenixChartStoryPages((offset) => (
      fetchStoryDetail(storySlug, PHOENIX_CHART_STORY_PAGE_SIZE, offset, {
        signal: controller.signal,
      })
    ))
      .then((detail) => {
        if (controller.signal.aborted) return;
        setState({
          status: 'ready',
          storySlug,
          story: detail.story,
          events: detail.events,
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || isAbortError(error)) return;
        if (__DEV__) console.warn('[PhoenixPriceChart] Story events unavailable', error);
        setState({ status: 'error', storySlug, story: null, events: EMPTY_EVENTS });
      });

    return () => controller.abort();
  }, [storySlug]);

  if (state.storySlug !== storySlug) {
    return {
      status: storySlug ? 'loading' : 'not-applicable',
      storySlug,
      story: null,
      events: EMPTY_EVENTS,
    };
  }

  return state;
}

function isAbortError(value: unknown): boolean {
  return value instanceof Error && value.name === 'AbortError';
}
