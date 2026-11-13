import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useFocusedAppStateInterval } from '@/hooks/useFocusedAppStateInterval';
import { fetchCalendar } from '../calendar.api';
import type { CalendarResult } from '../calendar.types';
import { eventCountdown, eventLocalDate, eventLocalTime, localDateKey, nextBigEvent, shiftDate } from '../feed-calendar';
import { FEED_TOKENS, monoFontFamily } from '../feed-design';
import { sectionFailureTitle } from '../feed-mosaic';
import { useFeedSection } from '../use-feed-section';
import { FeedSectionState } from './feed-section-state';
import { FeedBox } from './ui/FeedBox';
import { calendarDateLabel, eventFigureSummary } from './CalendarEventSheet';

const fetchWeek = (signal: AbortSignal): Promise<CalendarResult> => {
  const now = new Date();
  return fetchCalendar(shiftDate(localDateKey(now), -1), shiftDate(localDateKey(now), 7), signal);
};

/** Home calendar card. The whole card opens Calendar. Markets now lives one step further, on that screen. */
export function HomeCalendarCard({ active }: { active: boolean }) {
  const router = useRouter();
  const section = useFeedSection(fetchWeek, active);
  useFocusedAppStateInterval(() => { void section.load(); }, 5 * 60_000, { enabled: active });
  const [, setClock] = useState(0);
  useFocusedAppStateInterval(() => setClock((value) => value + 1), 60_000, { enabled: active });

  const now = new Date();
  const data = section.data;
  const usable = !!data && data.status !== 'unavailable';
  const weekFrom = localDateKey(now);
  const weekTo = shiftDate(weekFrom, 6);
  const weekEvents = usable
    ? data.events.filter((event) => {
      const day = eventLocalDate(event);
      return day >= weekFrom && day <= weekTo;
    })
    : [];
  const event = usable ? nextBigEvent(weekEvents, now) : null;
  const summary = event ? eventFigureSummary(event) : '';
  const openCalendar = () => router.push('/calendar');

  if (section.loading && !data) return <FeedSectionState title="Loading calendar…" loading />;
  if (section.error && !data) {
    return (
      <FeedSectionState
        title={sectionFailureTitle(section.error, 'Calendar unavailable')}
        text="Calendar could not be loaded."
        onRetry={() => { void section.load(); }}
      />
    );
  }
  if (data?.status === 'unavailable') {
    return <FeedSectionState title="Calendar unavailable" text="Calendar could not be loaded." onRetry={() => { void section.load(); }} />;
  }
  if (usable && !event) return <FeedSectionState title="No upcoming events this week" text="New events will appear here." />;
  if (!event) return null;

  return (
    <FeedBox tone="ground" onPress={openCalendar} accessibilityLabel={`Next big event: ${event.title}. Open calendar.`} style={styles.card}>
      <View style={styles.row}>
        <Text style={styles.label}>Calendar · next big event</Text>
        <Text style={styles.link}>Calendar →</Text>
      </View>
      <View style={styles.row}>
        <Text style={styles.title} numberOfLines={2}>{event.title}</Text>
        <Text style={styles.countdown}>{eventCountdown(event, now)}</Text>
      </View>
      <View style={styles.row}>
        <Text style={styles.meta} numberOfLines={1}>
          {calendarDateLabel(eventLocalDate(event), { weekday: 'short', day: 'numeric', month: 'short' })}
          {' · '}
          {eventLocalTime(event)}
        </Text>
        {summary ? <Text style={styles.meta} numberOfLines={1}>{summary}</Text> : null}
      </View>
      {section.error ? <Text selectable style={styles.notice}>Refresh failed. Showing the last loaded event.</Text> : null}
    </FeedBox>
  );
}

const styles = StyleSheet.create({
  card: { flex: 1, minHeight: 0, justifyContent: 'space-between', gap: 4 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  label: {
    flex: 1,
    color: FEED_TOKENS.colors.textFaint,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.label,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  link: {
    color: FEED_TOKENS.colors.accent,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.label,
    fontWeight: '600',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  title: { flex: 1, color: FEED_TOKENS.colors.text, fontSize: 18, lineHeight: 23, fontWeight: '700' },
  countdown: { color: FEED_TOKENS.colors.text, fontFamily: monoFontFamily(), fontSize: 28, lineHeight: 32, fontWeight: '700' },
  meta: {
    flexShrink: 1,
    color: FEED_TOKENS.colors.textDim,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.label,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  notice: { color: FEED_TOKENS.colors.textDim, fontSize: 12, lineHeight: 16 },
});
