import { useCallback, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusedAppStateInterval } from '@/hooks/useFocusedAppStateInterval';
import { fetchCalendar } from './calendar.api';
import type { CalendarEvent } from './calendar.types';
import { eventLocalDate, eventLocalTime, eventMetaLabel, eventWhen, eventsByDay, isHighImpact, localDateKey, monthGrid, monthRange, shiftDate, shiftMonth } from './feed-calendar';
import { FEED_TOKENS, monoFontFamily } from './feed-design';
import { useFeedSection } from './use-feed-section';
import { FeedBox } from './components/ui/FeedBox';
import { FeedSectionState } from './components/feed-section-state';
import { CalendarEventSheet, calendarDateLabel, eventFigureSummary } from './components/CalendarEventSheet';

const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'] as const;

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
        <View style={styles.barSpacer} />
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
          {WEEKDAYS.map((weekday) => (
            <Text key={weekday} style={styles.weekday}>{weekday}</Text>
          ))}
        </View>
        {grid.map((row, rowIndex) => (
          <View key={rowIndex} style={styles.gridRow}>
            {row.map((cell) => {
              if (!cell.inMonth) {
                return (
                  <View key={cell.date} style={styles.cell}>
                    <View style={styles.chip}>
                      <Text style={[styles.cellDate, styles.cellDim]}>{Number(cell.date.slice(8))}</Text>
                    </View>
                  </View>
                );
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
                    <Text style={[styles.cellDate, (isPast || !cell.inMonth) ? styles.cellDim : null]}>
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
        {section.loading && !data ? <FeedSectionState title="Loading calendar…" loading /> : null}
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
              const summary = eventFigureSummary(event);
              return (
                <FeedBox
                  key={event.id}
                  tone="ground"
                  onPress={() => setSheetEvent(event)}
                  accessibilityLabel={`${event.title}, ${calendarDateLabel(selectedDay, { weekday: 'short', day: 'numeric', month: 'long' })}, ${eventLocalTime(event)}, ${eventWhen(event, now)}`}
                >
                  <Text style={styles.eventTime}>{eventLocalTime(event)}</Text>
                  <Text style={styles.eventTitle} numberOfLines={2}>{event.title}</Text>
                  <Text style={styles.eventContext}>
                    {eventMetaLabel(event)}
                    {' · '}
                    {eventWhen(event, now)}
                    {summary ? ` · ${summary}` : ''}
                  </Text>
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
  barSpacer: {
    width: 32,
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
    width: 38,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: FEED_TOKENS.radius.button,
  },
  chipSelected: {
    backgroundColor: FEED_TOKENS.colors.lift,
  },
  chipToday: {
    borderWidth: 1,
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
  eventTime: {
    color: FEED_TOKENS.colors.textDim,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.label,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  eventTitle: {
    color: FEED_TOKENS.colors.text,
    fontSize: FEED_TOKENS.type.body,
    lineHeight: 20,
    fontWeight: '600',
    marginTop: FEED_TOKENS.space.xs,
  },
  eventContext: {
    color: FEED_TOKENS.colors.textDim,
    fontSize: FEED_TOKENS.type.caption,
    lineHeight: 18,
    marginTop: FEED_TOKENS.space.xs,
  },
});