import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FEED_COLORS } from '@/features/feed/feed.constants';

interface MarketCalendarModalProps {
  visible: boolean;
  onClose: () => void;
}

interface CalendarEvent {
  day: number;
  shortLabel: string;
  time: string;
  title: string;
  context: string;
}

interface CalendarCell {
  key: string;
  day: number;
  month: 'previous' | 'current' | 'next';
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const EVENTS: CalendarEvent[] = [
  { day: 21, shortLabel: 'Jobs', time: '8:30 ET', title: 'US employment update', context: 'Previous releases and labor-market context' },
  { day: 24, shortLabel: 'SOL', time: 'Scheduled', title: 'SOL token unlock', context: 'Supply schedule and previous unlock context' },
  { day: 25, shortLabel: 'CPI', time: '8:30 ET', title: 'US CPI release', context: 'Previous releases, expectations and market reactions' },
  { day: 26, shortLabel: 'NVDA', time: 'After market', title: 'NVIDIA earnings', context: 'Prior guidance, AI demand and supplier context' },
  { day: 28, shortLabel: 'Fed', time: '10:00 ET', title: 'Fed Chair remarks', context: 'Recent FOMC, CPI and rate-market context' },
];

const CELLS: CalendarCell[] = [
  ...Array.from({ length: 6 }, (_, index) => ({ key: `jul-${26 + index}`, day: 26 + index, month: 'previous' as const })),
  ...Array.from({ length: 31 }, (_, index) => ({ key: `aug-${index + 1}`, day: index + 1, month: 'current' as const })),
  ...Array.from({ length: 5 }, (_, index) => ({ key: `sep-${index + 1}`, day: index + 1, month: 'next' as const })),
];

export function MarketCalendarModal({ visible, onClose }: MarketCalendarModalProps) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const [selectedDay, setSelectedDay] = useState(25);
  const calendarWidth = Math.min(width - 24, 430);
  const cellWidth = (calendarWidth - 2) / 7;
  const eventByDay = useMemo(() => new Map(EVENTS.map((event) => [event.day, event])), []);
  const selectedEvent = eventByDay.get(selectedDay) ?? null;

  useEffect(() => {
    if (visible) setSelectedDay(25);
  }, [visible]);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <View style={[styles.screen, { paddingTop: insets.top }]}>
        <View style={styles.header}>
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Back to Feed"
            style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}
          >
            <MaterialIcons name="arrow-back" size={19} color={FEED_COLORS.text} />
          </Pressable>
          <Text style={styles.headerTitle}>Market calendar</Text>
          <View style={styles.headerSpacer} />
        </View>

        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={[styles.content, { paddingBottom: Math.max(insets.bottom, 18) + 24 }]}
        >
          <View style={[styles.calendar, { width: calendarWidth }]}>
            <View style={styles.monthHeader}>
              <Text style={styles.monthTitle}>August 2026</Text>
              <Text style={styles.monthHint}>Tap a date for context</Text>
            </View>

            <View style={styles.weekdays} accessibilityElementsHidden>
              {WEEKDAYS.map((weekday) => <Text key={weekday} style={[styles.weekday, { width: cellWidth }]}>{weekday}</Text>)}
            </View>

            <View style={styles.grid}>
              {CELLS.map((cell) => {
                const event = cell.month === 'current' ? eventByDay.get(cell.day) : null;
                const selected = cell.month === 'current' && cell.day === selectedDay;
                return (
                  <Pressable
                    key={cell.key}
                    disabled={cell.month !== 'current'}
                    onPress={() => setSelectedDay(cell.day)}
                    accessibilityRole="button"
                    accessibilityLabel={event ? `August ${cell.day}, ${event.title}` : `August ${cell.day}`}
                    style={({ pressed }) => [
                      styles.day,
                      { width: cellWidth, height: Math.max(60, cellWidth * 1.14) },
                      cell.month !== 'current' && styles.dayOutside,
                      selected && styles.daySelected,
                      pressed && styles.pressed,
                    ]}
                  >
                    <Text style={[styles.dayNumber, cell.month !== 'current' && styles.dayNumberOutside]}>{cell.day}</Text>
                    {event ? <Text style={styles.eventLabel} numberOfLines={1}>{event.shortLabel}</Text> : null}
                  </Pressable>
                );
              })}
            </View>

            <View style={styles.selection}>
              <Text style={styles.selectionDate}>AUGUST {selectedDay}, 2026</Text>
              {selectedEvent ? (
                <View style={styles.eventCard}>
                  <Text style={styles.eventTime}>{selectedEvent.time}</Text>
                  <Text style={styles.eventTitle}>{selectedEvent.title}</Text>
                  <Text style={styles.eventContext}>{selectedEvent.context}</Text>
                </View>
              ) : (
                <View style={styles.emptyCard}>
                  <Text style={styles.emptyTitle}>No scheduled event</Text>
                  <Text style={styles.emptyText}>Select a highlighted date to open its existing market context.</Text>
                </View>
              )}
            </View>
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: FEED_COLORS.screen,
  },
  header: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: FEED_COLORS.border,
  },
  backButton: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: FEED_COLORS.border,
    backgroundColor: FEED_COLORS.cardDeep,
  },
  headerTitle: {
    color: FEED_COLORS.text,
    fontSize: 20,
    lineHeight: 26,
    fontWeight: '900',
  },
  headerSpacer: {
    width: 32,
  },
  content: {
    alignItems: 'center',
    paddingTop: 18,
  },
  calendar: {
    alignSelf: 'center',
  },
  monthHeader: {
    paddingHorizontal: 2,
    paddingBottom: 16,
  },
  monthTitle: {
    color: FEED_COLORS.text,
    fontSize: 25,
    lineHeight: 31,
    fontWeight: '900',
  },
  monthHint: {
    color: FEED_COLORS.textDim,
    fontSize: 12,
    lineHeight: 17,
    paddingTop: 3,
  },
  weekdays: {
    flexDirection: 'row',
  },
  weekday: {
    color: FEED_COLORS.textFaint,
    fontFamily: 'monospace',
    fontSize: 8,
    lineHeight: 16,
    fontWeight: '800',
    textAlign: 'center',
    textTransform: 'uppercase',
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    borderTopWidth: 1,
    borderLeftWidth: 1,
    borderColor: FEED_COLORS.border,
    borderRadius: 8,
    overflow: 'hidden',
    borderCurve: 'continuous',
  },
  day: {
    borderRightWidth: 1,
    borderBottomWidth: 1,
    borderColor: FEED_COLORS.border,
    backgroundColor: FEED_COLORS.card,
    paddingHorizontal: 6,
    paddingVertical: 7,
  },
  dayOutside: {
    backgroundColor: FEED_COLORS.cardDeep,
    opacity: 0.48,
  },
  daySelected: {
    borderWidth: 1,
    borderColor: FEED_COLORS.accent,
    backgroundColor: FEED_COLORS.cardActive,
  },
  dayNumber: {
    color: FEED_COLORS.textDim,
    fontFamily: 'monospace',
    fontSize: 9,
    lineHeight: 13,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  dayNumberOutside: {
    color: FEED_COLORS.textFaint,
  },
  eventLabel: {
    color: FEED_COLORS.accent,
    fontFamily: 'monospace',
    fontSize: 8,
    lineHeight: 12,
    fontWeight: '900',
    paddingTop: 7,
  },
  selection: {
    paddingTop: 16,
  },
  selectionDate: {
    color: FEED_COLORS.textFaint,
    fontFamily: 'monospace',
    fontSize: 9,
    lineHeight: 13,
    fontWeight: '800',
    letterSpacing: 0.8,
    paddingHorizontal: 2,
    paddingBottom: 9,
  },
  eventCard: {
    borderRadius: 9,
    borderWidth: 1,
    borderColor: FEED_COLORS.border,
    backgroundColor: FEED_COLORS.cardDeep,
    padding: 14,
    gap: 6,
    borderCurve: 'continuous',
  },
  eventTime: {
    color: FEED_COLORS.accent,
    fontFamily: 'monospace',
    fontSize: 9,
    lineHeight: 13,
    fontWeight: '900',
  },
  eventTitle: {
    color: FEED_COLORS.text,
    fontSize: 18,
    lineHeight: 23,
    fontWeight: '900',
  },
  eventContext: {
    color: FEED_COLORS.textDim,
    fontSize: 12,
    lineHeight: 18,
  },
  emptyCard: {
    borderRadius: 9,
    borderWidth: 1,
    borderColor: FEED_COLORS.border,
    backgroundColor: FEED_COLORS.card,
    padding: 14,
    gap: 5,
    borderCurve: 'continuous',
  },
  emptyTitle: {
    color: FEED_COLORS.text,
    fontSize: 15,
    lineHeight: 20,
    fontWeight: '900',
  },
  emptyText: {
    color: FEED_COLORS.textDim,
    fontSize: 12,
    lineHeight: 18,
  },
  pressed: {
    opacity: 0.72,
  },
});
