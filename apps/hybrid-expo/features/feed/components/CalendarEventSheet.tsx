import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { FEED_TOKENS, monoFontFamily } from '../feed-design';
import { eventFigures, eventLocalDate, eventLocalTime, eventMetaLabel, eventReactionSample, eventWhen } from '../feed-calendar';
import type { CalendarEvent } from '../calendar.types';
import { FeedSheet } from './ui/FeedSheet';
import { SampleDataLabel } from './ui/SampleDataLabel';

/**
 * View-level date/time glue shared by the calendar surfaces (slide, sheet,
 * screen). All days and times follow the device's local zone; no zone label.
 */

export function calendarDateLabel(date: string, options: Intl.DateTimeFormatOptions): string {
  // Local noon keeps the calendar date stable across zones and DST edges.
  return new Date(`${date}T12:00:00`).toLocaleDateString('en-GB', options);
}

/** One-figure summary line, e.g. 'Est 4.25%' / 'EPS est $5.25'. Empty when absent. */
export function eventFigureSummary(event: CalendarEvent): string {
  const figure = eventFigures(event)[0];
  if (!figure || figure.value === '—') return '';
  return `${figure.label === 'Consensus' ? 'Est' : figure.label} ${figure.value}`;
}

interface CalendarEventSheetProps {
  event: CalendarEvent | null;
  onClose: () => void;
}

/**
 * Event bottom sheet (mock #s-eventsheet, DESIGN.md §12): meta, title, when
 * line, figure boxes, mocked last-3-times reaction (mock-gated) and the
 * Backpack source link. No Remind me button — out of scope for #498.
 */
export function CalendarEventSheet({ event, onClose }: CalendarEventSheetProps) {
  // One instant per render so the countdown and table agree.
  const now = new Date();
  const reaction = eventReactionSample();
  return (
    <FeedSheet visible={event !== null} onClose={onClose}>
      {event ? (
        <View>
          <Text accessibilityRole="header" style={styles.meta}>
            {eventMetaLabel(event)}
          </Text>
          <Text style={styles.title}>{event.title}</Text>
          <Text style={styles.when}>
            {calendarDateLabel(eventLocalDate(event), { weekday: 'short', day: 'numeric', month: 'short' })}
            {' · '}
            {eventLocalTime(event)}
            {' · '}
            {eventWhen(event, now)}
          </Text>
          <View style={styles.figures}>
            {eventFigures(event).map((figure) => (
              <View key={figure.label} style={styles.figureBox}>
                <Text style={styles.figureLabel}>{figure.label}</Text>
                <Text style={styles.figureValue}>{figure.value}</Text>
              </View>
            ))}
          </View>
          {reaction ? (
            <View style={styles.reaction}>
              <Text style={styles.reactionHeading}>LAST 3 TIMES · 24H MOVE</Text>
              <SampleDataLabel enabled />
              <View style={styles.tableRow}>
                {['Date', 'Result', 'BTC', 'SPX', 'Gold'].map((head) => (
                  <Text key={head} style={[styles.tableHeadCell, head === 'Result' && styles.tableHeadCellWide]}>
                    {head}
                  </Text>
                ))}
              </View>
              {reaction.map((row) => (
                <View key={row.date} style={styles.tableRow}>
                  <Text style={styles.tableCell}>{row.date}</Text>
                  <Text style={[styles.tableCell, styles.tableHeadCellWide]}>{row.result}</Text>
                  <Text style={[styles.tableCell, reactionValueStyles(row.btc)]}>{row.btc}</Text>
                  <Text style={[styles.tableCell, reactionValueStyles(row.spx)]}>{row.spx}</Text>
                  <Text style={[styles.tableCell, reactionValueStyles(row.gold)]}>{row.gold}</Text>
                </View>
              ))}
            </View>
          ) : null}
          <Pressable
            accessibilityRole="link"
            accessibilityLabel="Open event source"
            onPress={() => { void Linking.openURL(event.sourceUrl); }}
            style={styles.sourceLink}
          >
            <Text style={styles.sourceLinkLabel}>View source ↗</Text>
          </Pressable>
        </View>
      ) : null}
    </FeedSheet>
  );
}

function reactionValueStyles(value: string): { color?: string } {
  if (value.startsWith('-')) return { color: FEED_TOKENS.colors.down };
  if (value.startsWith('+')) return { color: FEED_TOKENS.colors.up };
  return {};
}

const styles = StyleSheet.create({
  meta: {
    color: FEED_TOKENS.colors.text,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.label,
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginBottom: FEED_TOKENS.space.sm,
  },
  title: {
    color: FEED_TOKENS.colors.text,
    fontSize: FEED_TOKENS.type.section,
    lineHeight: 25,
    fontWeight: '700',
    letterSpacing: -0.2,
  },
  when: {
    color: FEED_TOKENS.colors.textDim,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.label,
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginTop: FEED_TOKENS.space.xs,
  },
  figures: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: FEED_TOKENS.space.sm,
    marginTop: FEED_TOKENS.space.md,
  },
  figureBox: {
    flexBasis: '46%',
    flexGrow: 1,
    borderWidth: 1,
    borderColor: FEED_TOKENS.colors.border,
    borderRadius: FEED_TOKENS.radius.card,
    backgroundColor: FEED_TOKENS.colors.card,
    padding: FEED_TOKENS.space.md,
    gap: FEED_TOKENS.space.xs,
  },
  figureLabel: {
    color: FEED_TOKENS.colors.textFaint,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.label,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  figureValue: {
    color: FEED_TOKENS.colors.text,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.cardTitle,
    fontWeight: '700',
  },
  reaction: {
    marginTop: FEED_TOKENS.space.xl,
    gap: FEED_TOKENS.space.sm,
  },
  reactionHeading: {
    color: FEED_TOKENS.colors.text,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.label,
    fontWeight: '600',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  tableRow: {
    flexDirection: 'row',
    gap: FEED_TOKENS.space.sm,
    borderTopWidth: 1,
    borderTopColor: FEED_TOKENS.colors.border,
    paddingVertical: FEED_TOKENS.space.sm,
  },
  tableHeadCell: {
    color: FEED_TOKENS.colors.textFaint,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.label,
    letterSpacing: 1,
    textTransform: 'uppercase',
    flex: 1,
  },
  tableHeadCellWide: {
    flex: 1.6,
  },
  tableCell: {
    flex: 1,
    color: FEED_TOKENS.colors.text,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.caption,
    lineHeight: 17,
  },
  sourceLink: {
    marginTop: FEED_TOKENS.space.xl,
    minHeight: 44,
    alignSelf: 'flex-start',
    justifyContent: 'center',
  },
  sourceLinkLabel: {
    color: FEED_TOKENS.colors.accent,
    fontSize: FEED_TOKENS.type.caption,
    fontWeight: '700',
  },
});