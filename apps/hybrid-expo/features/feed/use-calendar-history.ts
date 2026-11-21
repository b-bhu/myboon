import { useEffect, useRef, useState } from 'react';
import type { CalendarHistoryResponse } from '@myboon/shared/calendar';
import type { CalendarEvent } from './calendar.types';
import { fetchCalendarHistory } from './calendar.api';
import { calendarHistoryRequest } from './feed-calendar';

/**
 * The event sheet's Last-3-times history (#704). Fetches only while the sheet
 * is open on an economic event whose `entitySlug` is set, with
 * `before = event.date` — earnings events, unmatched events and a closed sheet
 * never fetch and read as null (no block, no placeholder, no retry). Closing
 * the sheet or switching events aborts the in-flight request, and a stale
 * response never replaces the current event's one, the use-story-detail way.
 */
export function useCalendarHistory(event: CalendarEvent | null): CalendarHistoryResponse | null {
  const [history, setHistory] = useState<CalendarHistoryResponse | null>(null);
  const generation = useRef(0);
  const request = calendarHistoryRequest(event);
  const entity = request?.entity ?? null;
  const before = request?.before ?? null;

  useEffect(() => {
    const currentGeneration = ++generation.current;
    const controller = new AbortController();
    setHistory(null);
    if (entity && before) {
      void fetchCalendarHistory(entity, before, controller.signal)
        .then((response) => {
          if (!controller.signal.aborted && currentGeneration === generation.current) setHistory(response);
        })
        .catch(() => {
          if (!controller.signal.aborted && currentGeneration === generation.current) setHistory(null);
        });
    }
    return () => { generation.current += 1; controller.abort(); };
  }, [entity, before]);

  return history;
}
