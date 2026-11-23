import { useCallback, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusedAppStateInterval } from '@/hooks/useFocusedAppStateInterval';
import { fetchCalendar } from './calendar.api';
import type { CalendarEvent } from './calendar.types';
import { eventCardMeta, eventImpactPips, eventLocalDate, eventLocalTime, eventWhen, eventsByDay, isHighImpact, localDateKey, monthGrid, monthRange, shiftDate, shiftMonth } from './feed-calendar';
import { FEED_TOKENS, monoFontFamily } from './feed-design';
import { useFeedSection } from './use-feed-section';
import { FeedBox } from './components/ui/FeedBox';
import { FeedSectionState } from './components/feed-section-state';
import { CalendarEventSheet, calendarDateLabel } from './components/CalendarEventSheet';

const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'] as const;

/**
 * The mock's impact pips on an event card (#s-calendar .imp, #798): three
 * square boxes, the event's impact level lighting them from the left.
 */
function ImpactPips({ filled }: { filled: number }) {
  return (
    <View style={styles.pipRow} accessibilityElementsHidden>
      {Array.from({ length: 3 }, (_, index) => (
        <View key={index} style={[styles.pip, index < filled ? styles.pipOn : null]} />
      ))}
    </View>
  );
}

/**
 * Full-screen Calendar (issue #498, markup per feed-mock.html #s-calendar,
 * DESIGN.md §7): top bar, month header with arrows, Monday-first month grid
 * with today ring / selected fill / impact dots, then the selected day's
 * event list. One month of calendar events per fetch; days and times follow
 * the device's local zone.
 */
export default function CalendarScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [monthDate, setMonthDate] = useState(() => `${localDateKey(new Date()).slice(0, 7)}-01`);
  const [pickedDay, setPickedDay] = useState<string | null>(null);
  const [sheetEvent, setSheetEvent] = useState<CalendarEvent | null>(null);

  const fetchMonth = useCallback((signal: AbortSignal) => {
    const range = monthRange(monthDate);
    // Events can shift across a local midnight, so also read the day on each
    // side. The API caps a request at 31 days, so the edge days are separate
    // best-effort requests; the month request owns status and errors.
    const before = shiftDate(range.from, -1);
    const after = shiftDate(range.to, 1);
    const edge = (day: string) => fetchCalendar(day, day, signal).then((result) => result.events).catch(() => []);
    return Promise.all([fetchCalendar(range.from, range.to, signal), edge(before), edge(after)])
      .then(([month, early, late]) => {
        const seen = new Set(month.events.map((event) => event.id));
        const extra = [...early, ...late].filter((event) => !seen.has(event.id));
        return { ...month, range: { ...month.range, from: before, to: after }, events: [...extra, ...month.events] };
      });
  }, [monthDate]);
  const section = useFeedSection(fetchMonth);
  useFocusedAppStateInterval(() => { void section.load(); }, 5 * 60_000);

  const { from, to } = monthRange(monthDate);
  const fetchFrom = shiftDate(from, -1);
  const fetchTo = shiftDate(to, 1);
  // Keep the last month on screen while the next one loads.
  const data = section.data?.range.from === fetchFrom && section.data.range.to === fetchTo ? section.data : null;
  const usable = !!data && data.status !== 'unavailable';

  // One instant per render so the today ring and event labels agree.
  const now = new Date();
  const today = localDateKey(now);
  // Default selection: today when it is on this grid, otherwise day one.
  const selectedDay = pickedDay ?? (today.slice(0, 7) === monthDate.slice(0, 7) ? today : monthDate);
  const stepMonth = (delta: number) => {
    setPickedDay(null);
    setMonthDate((value) => shiftMonth(value, delta));
  };

  const grid = monthGrid(monthDate);
  const byDay = usable
    ? eventsByDay(data.events.filter((event) => {
      const day = eventLocalDate(event);
      return day >= from && day <= to;
    }))
    : {};
  const dayEvents = byDay[selectedDay] ?? [];
  const sourceNotes = usable
    ? data.sources.filter((source) => source.status !== 'ready')
      .map((source) => `${source.type === 'earnings' ? 'Earnings' : 'Economic'} ${source.status}`).join(' · ')
    : '';

  return (
    <View style={[styles.screen, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <View style={styles.bar}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
          onPress={() => router.back()}
          style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}
        >
          <Text style={styles.backGlyph}>‹</Text>
        </Pressable>
        <Text accessibilityRole="header" style={styles.barLabel}>Calendar</Text>
        <Pressable accessibilityRole="link" accessibilityLabel="Markets now" onPress={() => router.push('/markets-now')} style={styles.marketsLink}>
          <Text style={styles.marketsLinkLabel}>Markets →</Text>
        </Pressable>
      </View>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={section.loading}
            onRefresh={() => { void section.load(); }}
            tintColor={FEED_TOKENS.colors.accent}
            colors={[FEED_TOKENS.colors.accent]}
          />
        }
      >
        <View style={styles.monthRow}>
          <Text accessibilityRole="header" style={styles.monthLabel}>
            {calendarDateLabel(monthDate, { month: 'long', year: 'numeric' })}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Previous month"
            onPress={() => stepMonth(-1)}
            style={styles.step}
          >
            <Text style={styles.stepGlyph}>‹</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Next month"
            onPress={() => stepMonth(1)}
            style={styles.step}
          >
            <Text style={styles.stepGlyph}>›</Text>
          </Pressable>
        </View>
        <View style={styles.weekdayRow}>
          {WEEKDAYS.map((weekday, index) => (
            <Text key={`${weekday}-${index}`} style={styles.weekday}>{weekday}</Text>
          ))}
        </View>
        {grid.map((row, rowIndex) => (
          <View key={rowIndex} style={styles.gridRow}>
            {row.map((cell) => {
              // The mock's leading and trailing slots are empty (docs/design/
              // feed.html #s-calendar): only in-month days paint a bordered cell.
              if (!cell.inMonth) {
                return <View key={cell.date} style={styles.cell} />;
              }
              const events = byDay[cell.date] ?? [];
              const isSelected = cell.date === selectedDay;
              const isToday = cell.date === today;
              const isPast = cell.date < today;
              const high = events.some(isHighImpact);
              return (
                <Pressable
                  key={cell.date}
                  accessibilityRole="button"
                  accessibilityLabel={`Day ${Number(cell.date.slice(8))}, ${events.length} events`}
                  accessibilityState={{ selected: isSelected }}
                  onPress={() => setPickedDay(cell.date)}
                  style={styles.cell}
                >
                  <View
                    style={[
                      styles.chip,
                      isSelected && styles.chipSelected,
                      isToday && styles.chipToday,
                    ]}
                  >
                    <Text style={[styles.cellDate, isPast ? styles.cellDim : null]}>
                      {Number(cell.date.slice(8))}
                    </Text>
                    <View
                      style={[styles.dot, high ? styles.dotHigh : events.length ? styles.dotLow : null]}
                      accessibilityElementsHidden
                    />
                  </View>
                </Pressable>
              );
            })}
          </View>
        ))}
        {section.loading && !data ? <CalendarListSkeleton /> : null}
        {section.error && !data ? (
          <FeedSectionState title="Calendar unavailable" text="Calendar could not be loaded." onRetry={() => { void section.load(); }} />
        ) : null}
        {data?.status === 'unavailable' ? (
          <FeedSectionState title="Calendar unavailable" text="Calendar could not be loaded." onRetry={() => { void section.load(); }} />
        ) : null}
        {section.error && data ? <Text selectable style={styles.sourceNote}>Refresh failed; showing saved schedule.</Text> : null}
        {usable && sourceNotes ? <Text selectable style={styles.sourceNote}>{sourceNotes}</Text> : null}
        {usable ? (
          <View style={styles.dayBlock}>
            <View style={styles.dayHeading}>
              <Text accessibilityRole="header" style={styles.dayTitle}>
                {calendarDateLabel(selectedDay, { weekday: 'short', day: 'numeric' })}
              </Text>
              <Text style={styles.dayMeta}>{dayEvents.length === 1 ? '1 event' : `${dayEvents.length} events`}</Text>
            </View>
            {dayEvents.length ? dayEvents.map((event) => {
              const meta = eventCardMeta(event);
              return (
                <FeedBox
                  key={event.id}
                  tone="ground"
                  onPress={() => setSheetEvent(event)}
                  accessibilityLabel={`${event.title}, ${calendarDateLabel(selectedDay, { weekday: 'short', day: 'numeric', month: 'long' })}, ${eventLocalTime(event)}, ${eventWhen(event, now)}`}
                >
                  <View style={styles.eventMeta}>
                    <Text style={styles.eventTime}>{eventLocalTime(event)}</Text>
                    <ImpactPips filled={eventImpactPips(event)} />
                  </View>
                  <Text style={styles.eventTitle} numberOfLines={2}>{event.title}</Text>
                  {meta ? <Text style={styles.eventContext}>{meta}</Text> : null}
                </FeedBox>
              );
            }) : (
              <FeedSectionState title="No events this day" />
            )}
          </View>
        ) : null}
      </ScrollView>
      <CalendarEventSheet event={sheetEvent} onClose={() => setSheetEvent(null)} />
    </View>
  );
}

/**
 * First-load skeleton for the Calendar events list (#797): the month grid
 * renders above while these event-card placeholders stand in for the real
 * FeedBox rows, so the screen does not jump on arrival.
 */
function CalendarListSkeleton() {
  return (
    <View style={skeletonStyles.list}>
      {[0, 1, 2].map((index) => (
        <FeedBox key={index} tone="ground">
          <View style={[skeletonStyles.line, skeletonStyles.time]} />
          <View style={[skeletonStyles.line, skeletonStyles.title]} />
          <View style={[skeletonStyles.line, skeletonStyles.context]} />
        </FeedBox>
      ))}
    </View>
  );
}

const skeletonStyles = StyleSheet.create({
  list: { gap: FEED_TOKENS.space.sm, marginTop: FEED_TOKENS.space.md },
  line: { height: 12, borderRadius: 4, backgroundColor: FEED_TOKENS.colors.border },
  time: { width: 56 },
  title: { height: 16, width: '70%' },
  context: { width: '52%' },
});

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: FEED_TOKENS.colors.screen,
  },
  bar: {
    height: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: FEED_TOKENS.space.lg,
  },
  backButton: {
    minHeight: 44,
    width: 32,
    alignItems: 'flex-start',
    justifyContent: 'center',
  },
  backGlyph: {
    color: FEED_TOKENS.colors.text,
    fontSize: FEED_TOKENS.type.title,
  },
  barLabel: {
    color: FEED_TOKENS.colors.text,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.label,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  marketsLink: { minHeight: 44, justifyContent: 'center', paddingLeft: 12 },
  marketsLinkLabel: {
    color: FEED_TOKENS.colors.accent,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.label,
    fontWeight: '600',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  pressed: {
    opacity: 0.76,
  },
  content: {
    paddingTop: FEED_TOKENS.space.xs,
    paddingBottom: FEED_TOKENS.space.xl,
    paddingHorizontal: FEED_TOKENS.space.lg,
    gap: FEED_TOKENS.space.md,
  },
  monthRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: FEED_TOKENS.space.md,
  },
  monthLabel: {
    flex: 1,
    color: FEED_TOKENS.colors.text,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.label,
    fontWeight: '600',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  step: {
    width: 32,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepGlyph: {
    color: FEED_TOKENS.colors.textDim,
    fontSize: FEED_TOKENS.type.cardTitle,
  },
  weekdayRow: {
    flexDirection: 'row',
  },
  weekday: {
    flex: 1,
    textAlign: 'center',
    color: FEED_TOKENS.colors.textFaint,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.label,
    letterSpacing: 1,
  },
  gridRow: {
    flexDirection: 'row',
  },
  cell: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: FEED_TOKENS.space.xs,
  },
  chip: {
    position: 'relative',
    // The mock's day cell (docs/design/feed.html #s-calendar): 38 px square,
    // 1 px hairline border, 4 radius (#798).
    width: 38,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: FEED_TOKENS.colors.border,
    borderRadius: FEED_TOKENS.radius.chip,
  },
  chipSelected: {
    backgroundColor: FEED_TOKENS.colors.lift,
  },
  chipToday: {
    borderColor: FEED_TOKENS.colors.accent,
  },
  cellDate: {
    color: FEED_TOKENS.colors.text,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.caption,
    fontWeight: '600',
  },
  cellDim: {
    color: FEED_TOKENS.colors.textFaint,
  },
  dot: {
    position: 'absolute',
    bottom: 3,
    width: 4,
    height: 4,
    borderRadius: 2,
  },
  dotHigh: {
    backgroundColor: FEED_TOKENS.colors.accent,
  },
  dotLow: {
    backgroundColor: FEED_TOKENS.colors.textFaint,
  },
  sourceNote: {
    color: FEED_TOKENS.colors.textFaint,
    fontSize: FEED_TOKENS.type.caption,
    lineHeight: 17,
  },
  dayBlock: {
    gap: FEED_TOKENS.space.md,
  },
  dayHeading: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: FEED_TOKENS.space.sm,
    marginTop: FEED_TOKENS.space.sm,
  },
  dayTitle: {
    color: FEED_TOKENS.colors.text,
    fontSize: FEED_TOKENS.type.section,
    fontWeight: '700',
  },
  dayMeta: {
    color: FEED_TOKENS.colors.textDim,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.label,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  eventMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: FEED_TOKENS.space.sm,
  },
  eventTime: {
    color: FEED_TOKENS.colors.textDim,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.label,
    lineHeight: 14,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  pipRow: {
    flexDirection: 'row',
    gap: 3,
  },
  pip: {
    width: 6,
    height: 6,
    borderWidth: 1,
    borderColor: FEED_TOKENS.colors.textFaint,
  },
  pipOn: {
    backgroundColor: FEED_TOKENS.colors.text,
    borderColor: FEED_TOKENS.colors.text,
  },
  eventTitle: {
    color: FEED_TOKENS.colors.text,
    fontSize: FEED_TOKENS.type.cardTitle,
    lineHeight: 23,
    fontWeight: '700',
    marginTop: 4,
  },
  eventContext: {
    color: FEED_TOKENS.colors.textDim,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.label,
    lineHeight: 14,
    fontWeight: '600',
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginTop: 2,
  },
});