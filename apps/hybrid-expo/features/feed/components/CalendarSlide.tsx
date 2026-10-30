import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useFocusedAppStateInterval } from '@/hooks/useFocusedAppStateInterval';
import { fetchCalendar } from '../calendar.api';
import type { CalendarEvent, CalendarResult } from '../calendar.types';
import { countdown, countdownLower, nextBigEvent, weekCount } from '../feed-calendar';
import { FEED_TOKENS, monoFontFamily } from '../feed-design';
import { useFeedSection } from '../use-feed-section';
import { FeedSectionState } from './feed-section-state';
import { FeedBox } from './ui/FeedBox';
import { CalendarEventSheet, calendarDateLabel, eventCountdownTarget, eventFigureSummary, eventTimeLabel } from './CalendarEventSheet';

interface CalendarSlideProps {
  active: boolean;
  refreshVersion: number;
}

// Always resolves the rolling seven-day window (today..+6 UTC) at call time,
// so a tick past midnight rolls the window forward with the next fetch.
const fetchWeek = (signal: AbortSignal): Promise<CalendarResult> => {
  const now = new Date();
  const from = now.toISOString().slice(0, 10);
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 6)).toISOString().slice(0, 10);
  return fetchCalendar(from, to, signal);
};

/**
 * Calendar slide (feed-mock.html #s-slides, DESIGN.md §7/§8): the next big
 * event card. The card body opens the event sheet; the gold link opens the
 * full Calendar screen.
 */
export function CalendarSlide({ active, refreshVersion }: CalendarSlideProps) {
  const router = useRouter();
  const section = useFeedSection(fetchWeek, active);
  const previousRefresh = useRef(refreshVersion);
  useEffect(() => {
    if (previousRefresh.current === refreshVersion) return;
    previousRefresh.current = refreshVersion;
    if (active) void section.load();
  }, [active, refreshVersion, section.load]);
  useFocusedAppStateInterval(() => { void section.load(); }, 5 * 60_000, { enabled: active });
  // Minute tick keeps the countdown honest between refetches.
  const [, setClock] = useState(0);
  useFocusedAppStateInterval(() => setClock((value) => value + 1), 60_000, { enabled: active });
  const [sheetEvent, setSheetEvent] = useState<CalendarEvent | null>(null);

  // One instant per render so countdown and "+N this week" agree.
  const now = new Date();
  const data = section.data;
  const usable = !!data && data.status !== 'unavailable';
  const event = usable ? nextBigEvent(data.events, now) : null;
  const othersThisWeek = usable ? weekCount(data.events, now) - 1 : 0;
  const summary = event ? eventFigureSummary(event) : '';

  return (
    <View>
      {section.loading && !section.data ? <FeedSectionState title="Loading calendar…" loading /> : null}
      {section.error && !section.data ? (
        <FeedSectionState title="Calendar unavailable" text="Calendar could not be loaded." onRetry={() => { void section.load(); }} />
      ) : null}
      {usable && !event ? <FeedSectionState title="No upcoming events this week" text="New events will appear here." /> : null}
      {event ? (
        <FeedBox
          tone="ground"
          onPress={() => setSheetEvent(event)}
          accessibilityLabel={`Next big event: ${event.title}, ${countdownLower(eventCountdownTarget(event), now)}`}
          style={styles.card}
        >
          <View style={styles.headerRow}>
            <Text style={styles.monoCaps}>CALENDAR · NEXT BIG EVENT</Text>
            <Pressable
              accessibilityRole="link"
              accessibilityLabel="Open calendar"
              onPress={() => {
                setSheetEvent(null);
                router.push('/calendar');
              }}
              style={styles.linkTouch}
            >
              <Text style={styles.link}>Calendar →</Text>
            </Pressable>
          </View>
          <View style={styles.countdownRow}>
            <Text style={styles.countdown}>{countdown(eventCountdownTarget(event), now)}</Text>
            <Text style={styles.until}>until</Text>
          </View>
          <Text style={styles.title} numberOfLines={2}>{event.title}</Text>
          <Text style={styles.metaLine} numberOfLines={1}>
            {calendarDateLabel(event.date, { weekday: 'short', day: 'numeric', month: 'short' })}
            {' · '}
            {eventTimeLabel(event)}
            {summary ? ` · ${summary}` : ''}
          </Text>
          {othersThisWeek > 0 ? (
            <View style={styles.footer}>
              <Text style={styles.monoCaps}>+{othersThisWeek} this week</Text>
            </View>
          ) : null}
        </FeedBox>
      ) : null}
      <CalendarEventSheet event={sheetEvent} onClose={() => setSheetEvent(null)} />
    </View>
  );
}

const styles = StyleSheet.create({
  // Mock .card.sl is a 236-tall boxed card; keep at least that much room.
  card: {
    minHeight: 236,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: FEED_TOKENS.space.sm,
  },
  monoCaps: {
    color: FEED_TOKENS.colors.textDim,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.label,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  linkTouch: {
    minHeight: 44,
    justifyContent: 'center',
  },
  link: {
    color: FEED_TOKENS.colors.accent,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.label,
    fontWeight: '600',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  countdownRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: FEED_TOKENS.space.sm,
    marginTop: FEED_TOKENS.space.md,
  },
  countdown: {
    color: FEED_TOKENS.colors.text,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.big,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  until: {
    color: FEED_TOKENS.colors.textDim,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.label,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  title: {
    color: FEED_TOKENS.colors.text,
    fontSize: FEED_TOKENS.type.cardTitle,
    lineHeight: 23,
    fontWeight: '600',
    marginTop: FEED_TOKENS.space.xs,
  },
  metaLine: {
    color: FEED_TOKENS.colors.textDim,
    fontSize: FEED_TOKENS.type.label,
    lineHeight: 15,
    marginTop: FEED_TOKENS.space.xs,
  },
  footer: {
    borderTopWidth: 1,
    borderTopColor: FEED_TOKENS.colors.border,
    marginTop: FEED_TOKENS.space.md,
    paddingTop: FEED_TOKENS.space.md,
  },
});