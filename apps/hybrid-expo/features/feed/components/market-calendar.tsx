import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useFocusedAppStateInterval } from '@/hooks/useFocusedAppStateInterval';
import { fetchCalendar } from '../calendar.api';
import type { CalendarEvent, CalendarResult } from '../calendar.types';
import { calendarPeriod, shiftCalendarDate, type CalendarMode } from '../feed-state';
import { FEED_COLORS as color } from '../feed.constants';
import { FeedDetailSheet } from './feed-detail-sheet';

function dateLabel(date: string, options: Intl.DateTimeFormatOptions) {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', { ...options, timeZone: 'UTC' });
}
function eventTime(event: CalendarEvent) {
  return event.timePrecision === 'time' && event.startsAt
    ? `${new Date(event.startsAt).toLocaleTimeString('en-GB', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit' })} UTC`
    : 'Time not provided';
}
function eventContext(event: CalendarEvent) {
  return event.type === 'earnings' ? `Earnings · ${event.symbol}` : ['Economic', event.currency || event.country, event.impact].filter(Boolean).join(' · ');
}
function EventRow({ event, onPress }: { event: CalendarEvent; onPress: (event: CalendarEvent) => void }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={`Open ${event.title}, ${event.date}, ${eventTime(event)}`} onPress={() => onPress(event)} style={styles.event}>
    <Text style={styles.small}>{dateLabel(event.date, { weekday: 'short', day: 'numeric', month: 'short' })} · {eventTime(event)}</Text>
    <Text style={styles.eventTitle}>{event.title}</Text>
    <Text style={styles.small}>{eventContext(event)}</Text>
  </Pressable>;
}

export function MarketCalendar({ active = true, initiallyExpanded = false, onClose, refreshVersion = 0, inline = true }: {
  active?: boolean; initiallyExpanded?: boolean; onClose?: () => void; refreshVersion?: number; inline?: boolean;
}) {
  const { fontScale } = useWindowDimensions();
  const [mode, setMode] = useState<CalendarMode>('week');
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const { from, to } = calendarPeriod(date, mode);
  const [data, setData] = useState<CalendarResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [sheet, setSheet] = useState<'all' | 'event' | null>(initiallyExpanded ? 'all' : null);
  const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(null);
  const current = data?.range.from === from && data.range.to === to ? data : null;

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void fetchCalendar(from, to, controller.signal).then((result) => {
      if (!controller.signal.aborted) setData(result);
    }).catch(() => {
      if (!controller.signal.aborted) setError('Calendar could not be loaded.');
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [active, from, to, retry, refreshVersion]);
  useFocusedAppStateInterval(() => setRetry((value) => value + 1), 5 * 60_000, { enabled: active });

  const step = (direction: number) => setDate((value) => shiftCalendarDate(value, direction * (mode === 'week' ? 7 : 1)));
  const openEvent = (event: CalendarEvent) => { setSelectedEvent(event); setSheet('event'); };
  const close = useCallback(() => { setSheet(null); setSelectedEvent(null); onClose?.(); }, [onClose]);
  const unavailable = current?.status === 'unavailable';
  const sourceProblems = current?.sources.filter((source) => source.status !== 'ready') ?? [];
  const retryable = Boolean(error) || !current || sourceProblems.some((source) => source.status === 'partial' || source.error?.retryable);
  const freshness = current?.sources.map((source) => source.fetchedAt).filter((value): value is string => !!value).sort().at(-1);
  const state = <View style={styles.state} accessibilityLiveRegion="polite">
    {loading ? <ActivityIndicator size="small" color={color.accent} /> : null}
    {error || unavailable ? <>
      <Text selectable style={styles.body}>{current?.events.length ? 'Refresh failed; showing saved schedule.' : unavailable ? 'Calendar unavailable' : error}</Text>
      {retryable ? <Pressable accessibilityRole="button" accessibilityLabel="Retry calendar" onPress={() => setRetry((value) => value + 1)} style={styles.touch}><Text style={styles.action}>Try again</Text></Pressable> : null}
    </> : null}
    {current && !unavailable && sourceProblems.length ? <>
      <Text selectable style={styles.small}>{sourceProblems.map((source) => `${source.type === 'earnings' ? 'Earnings' : 'Economic'} ${source.status}`).join(' · ')}</Text>
      {retryable ? <Pressable onPress={() => setRetry((value) => value + 1)} accessibilityRole="button" accessibilityLabel="Retry calendar sources" style={styles.touch}><Text style={styles.action}>Try again</Text></Pressable> : null}
    </> : null}
    {current && !unavailable && !current.events.length && !loading ? <Text style={styles.body}>{current.status === 'ready' ? 'No scheduled events' : 'No events from available sources'}</Text> : null}
  </View>;
  const controls = <>
    <View style={styles.modes}>{(['day', 'week'] as const).map((value) => <Pressable key={value} accessibilityRole="button" accessibilityLabel={`${value === 'day' ? 'Day' : 'Week'} calendar view`} accessibilityState={{ selected: value === mode }} onPress={() => setMode(value)} style={[styles.mode, mode === value && styles.selected]}><Text style={mode === value ? styles.body : styles.small}>{value === 'day' ? 'Day' : 'Week'}</Text></Pressable>)}</View>
    <View style={styles.date}>
      <Text style={styles.small}>{mode === 'week' ? 'Mon – Sun' : dateLabel(from, { weekday: 'long' })}</Text>
      <Text selectable style={[styles.number, { fontSize: mode === 'week' ? 29 : 43 }]}>{mode === 'week' ? `${from.slice(8)} – ${to.slice(8)}` : from.slice(8)}</Text>
      <Text style={styles.body}>{from.slice(0, 7) === to.slice(0, 7) ? dateLabel(from, { month: 'long', year: 'numeric' }) : `${dateLabel(from, { month: 'short', year: 'numeric' })} – ${dateLabel(to, { month: 'short', year: 'numeric' })}`}</Text>
    </View>
    <Text style={styles.small}>{current && !unavailable ? `${current.events.length} scheduled${current.partial ? ' · partial' : ''}` : loading ? 'Loading schedule…' : 'Schedule unavailable'}</Text>
    <View style={styles.steps}>{[-1, 1].map((direction) => <Pressable key={direction} accessibilityRole="button" accessibilityLabel={`${direction === -1 ? 'Previous' : 'Next'} calendar ${mode}`} onPress={() => step(direction)} style={styles.step}><Text style={styles.arrow}>{direction === -1 ? '‹' : '›'}</Text></Pressable>)}</View>
  </>;
  return <View>
    {inline ? <>
    <View style={styles.heading}><Text accessibilityRole="header" style={styles.title}>Calendar</Text><Pressable accessibilityRole="button" accessibilityLabel="All calendar events" onPress={() => setSheet('all')} style={styles.touch}><Text style={styles.action}>All events →</Text></Pressable></View>
    <View style={[styles.card, { height: 250 * Math.max(1, fontScale) }]}>
      <View style={styles.period}>{controls}</View>
      <View style={styles.agenda}>
        <View style={styles.agendaHeading}><Text style={styles.small}>Scheduled events</Text><Text style={styles.small}>UTC</Text></View>
        <ScrollView key={`${from}/${to}`} nestedScrollEnabled contentContainerStyle={{ paddingBottom: 8 }}>
          {state}{current?.events.map((event) => <EventRow key={event.id} event={event} onPress={openEvent} />)}
        </ScrollView>
      </View>
    </View>
    <Text selectable style={styles.source}>Backpack · {freshness ? `Fetched ${new Date(freshness).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} UTC` : 'Earnings & economic events'}</Text>
    </> : null}
    <FeedDetailSheet visible={sheet !== null} title={sheet === 'event' ? 'Calendar event' : 'All events'} onClose={close}>
      {sheet === 'all' ? <>
        <Text selectable style={styles.body}>{from} – {to} · UTC</Text>
        <Text style={styles.small}>Earnings & economic events · Backpack</Text>
        {state}{current?.events.map((event) => <EventRow key={event.id} event={event} onPress={openEvent} />)}
      </> : selectedEvent ? <>
        <Pressable accessibilityRole="button" onPress={() => setSheet('all')} style={styles.touch}><Text style={styles.action}>← All events</Text></Pressable>
        <Text selectable style={styles.detailTitle}>{selectedEvent.title}</Text>
        <Text selectable style={styles.body}>{dateLabel(selectedEvent.date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })} · {eventTime(selectedEvent)}</Text>
        <Text style={styles.body}>{eventContext(selectedEvent)}</Text>
        {(selectedEvent.type === 'earnings' ? [
          ['EPS estimate', selectedEvent.epsEstimated], ['EPS actual', selectedEvent.epsActual], ['Revenue estimate', selectedEvent.revenueEstimated], ['Revenue actual', selectedEvent.revenueActual],
        ] : [['Previous', selectedEvent.previous], ['Estimate', selectedEvent.estimate], ['Actual', selectedEvent.actual], ['Change', selectedEvent.change], ['Change (%)', selectedEvent.changePercentage]]).map(([label, value]) => <View key={String(label)} style={styles.stat}><Text style={styles.small}>{label}</Text><Text selectable style={styles.body}>{typeof value === 'number' ? value.toLocaleString('en-US') : 'Not available'}{selectedEvent.type === 'economic' && typeof value === 'number' ? label === 'Change (%)' ? ' %' : selectedEvent.unit ? ` ${selectedEvent.unit}` : '' : ''}</Text></View>)}
        {selectedEvent.type === 'earnings' && selectedEvent.providerUpdatedAt ? <Text selectable style={styles.small}>Provider updated {selectedEvent.providerUpdatedAt}</Text> : null}
        <Text style={styles.small}>Source: Backpack · Times and dates in UTC</Text>
        <Pressable accessibilityRole="link" accessibilityLabel="Open event source on Backpack" onPress={() => { void Linking.openURL(`https://backpack.exchange/stocks/calendar?type=${selectedEvent.type === 'earnings' ? 'earnings' : 'economic'}`); }} style={styles.touch}><Text style={styles.action}>View source ↗</Text></Pressable>
      </> : null}
    </FeedDetailSheet>
  </View>;
}

const styles = StyleSheet.create({
  heading: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  title: { color: color.text, fontSize: 22, lineHeight: 29, fontWeight: '800' },
  action: { color: color.accent, fontSize: 12, fontWeight: '700' },
  touch: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 4 },
  card: { flexDirection: 'row', padding: 6, gap: 6, backgroundColor: '#031F2C', borderRadius: 9, borderColor: color.border, borderWidth: 1 },
  period: { flex: 1, minWidth: 0, backgroundColor: color.card, borderRadius: 6, paddingHorizontal: 10, paddingTop: 8 },
  agenda: { flex: 1, minWidth: 0, paddingHorizontal: 6, paddingTop: 5 },
  agendaHeading: { flexDirection: 'row', justifyContent: 'space-between', gap: 3, paddingBottom: 8, flexWrap: 'wrap' },
  modes: { flexDirection: 'row', backgroundColor: '#031F2C', borderRadius: 5, padding: 2 },
  mode: { flex: 1, minHeight: 44, justifyContent: 'center', alignItems: 'center', borderRadius: 4 },
  selected: { backgroundColor: color.cardActive, borderWidth: 1, borderColor: color.border },
  date: { flex: 1, justifyContent: 'center', gap: 5, paddingVertical: 8 },
  number: { color: color.text, fontWeight: '800', fontVariant: ['tabular-nums'], letterSpacing: -1 },
  steps: { flexDirection: 'row', borderTopWidth: 1, borderColor: color.border, marginTop: 8 },
  step: { flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  arrow: { color: color.text, fontSize: 26 },
  small: { color: color.textDim, fontSize: 10, lineHeight: 15 },
  body: { color: color.text, fontSize: 12, lineHeight: 18 },
  event: { minHeight: 59, paddingVertical: 8, gap: 3, borderTopWidth: 1, borderColor: color.border },
  eventTitle: { color: color.text, fontSize: 15, lineHeight: 19, fontWeight: '700' },
  state: { gap: 5 },
  source: { color: color.textDim, fontSize: 10, paddingTop: 8 },
  detailTitle: { color: color.text, fontSize: 26, fontWeight: '800' },
  stat: { flexDirection: 'row', justifyContent: 'space-between', gap: 12, paddingVertical: 8, borderBottomWidth: 1, borderColor: color.border },
});
