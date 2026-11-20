import { useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useFocusedAppStateInterval } from '@/hooks/useFocusedAppStateInterval';
import { fetchCalendar } from '../calendar.api';
import type { CalendarResult } from '../calendar.types';
import { eventCountdown, eventLocalDate, eventLocalTime, eventMetaLine, localDateKey, nextBigEvent, shiftDate } from '../feed-calendar';
import { FEED_TOKENS, monoFontFamily } from '../feed-design';
import { sectionFailureTitle } from '../feed-mosaic';
import { FEED_HOME_STORAGE_KEYS } from '../feed-section-cache';
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
  // While a press is down on the card, a first fresh swap waits for the press
  // to end so the card under the finger does not move (#416).
  const hold = useRef(false);
  const pressDown = () => { hold.current = true; };
  const releasePress = () => { if (hold.current) { hold.current = false; section.release(); } };
  const section = useFeedSection(fetchWeek, active, { storageKey: FEED_HOME_STORAGE_KEYS.calendar, holdRef: hold });
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
    <View onTouchStart={pressDown} onTouchEnd={releasePress} onTouchCancel={releasePress}>
      <FeedBox tone="ground" onPress={openCalendar} accessibilityLabel={`Next big event: ${event.title}. Open calendar.`} style={styles.card}>
        <View style={styles.row}>
          <Text style={styles.label}>Next big event</Text>
          <Text style={styles.link}>Calendar →</Text>
        </View>
        <View style={styles.rowEnd}>
          <View style={styles.event}>
            <Text style={styles.title} numberOfLines={2}>{event.title}</Text>
            <Text style={styles.meta} numberOfLines={1}>
              {eventMetaLine(
                calendarDateLabel(eventLocalDate(event), { weekday: 'short', day: 'numeric', month: 'short' }),
                eventLocalTime(event),
                summary,
              )}
            </Text>
          </View>
          <Text style={styles.countdown} numberOfLines={1}>{eventCountdown(event, now)}</Text>
        </View>
        {section.error ? <Text selectable style={styles.notice}>Refresh failed. Showing the last loaded event.</Text> : null}
      </FeedBox>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { gap: 8 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  rowEnd: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12 },
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
  event: { flex: 1 },
  title: { color: FEED_TOKENS.colors.text, fontSize: 18, lineHeight: 23, fontWeight: '700' },
  countdown: { flexShrink: 0, color: FEED_TOKENS.colors.text, fontFamily: monoFontFamily(), fontSize: 28, lineHeight: 32, fontWeight: '700' },
  meta: {
    marginTop: 4,
    flexShrink: 1,
    color: FEED_TOKENS.colors.textDim,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.label,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  notice: { color: FEED_TOKENS.colors.textDim, fontSize: 12, lineHeight: 16 },
});
