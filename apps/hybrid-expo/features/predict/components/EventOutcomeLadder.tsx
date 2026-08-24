import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { semantic, tokens } from '@/theme';

/**
 * EventOutcomeLadder + ResolutionRulesSheet — multi-outcome event detail
 * (Predict redesign PRD §5). Odds display in three formats; execution prices
 * stay in contract cents.
 */

export type EventOddsFormat = 'probability' | 'decimal' | 'american';

export interface EventOutcomeRow {
  id: string;
  label: string;
  /** Probability 0–1. */
  price: number;
}

export function formatEventOdds(price: number, format: EventOddsFormat): string {
  if (!Number.isFinite(price) || price <= 0 || price >= 1) return '--';
  if (format === 'probability') return `${Math.round(price * 100)}%`;
  if (format === 'decimal') return (1 / price).toFixed(2);
  return price > 0.5
    ? `-${Math.round((price / (1 - price)) * 100)}`
    : `+${Math.round(((1 - price) / price) * 100)}`;
}

export function EventOutcomeLadder({
  outcomes,
  selectedId,
  onSelect,
  oddsFormat,
}: {
  outcomes: EventOutcomeRow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  oddsFormat: EventOddsFormat;
}) {
  return (
    <View accessibilityRole="list">
      {outcomes.map((outcome) => {
        const selected = outcome.id === selectedId;
        return (
          <Pressable
            key={outcome.id}
            accessibilityRole="button"
            accessibilityLabel={`${outcome.label} at ${formatEventOdds(outcome.price, oddsFormat)}`}
            accessibilityState={{ selected }}
            style={[styles.row, selected && styles.rowSelected]}
            onPress={() => onSelect(outcome.id)}>
            <Text style={[styles.rowLabel, selected && styles.rowLabelSelected]} numberOfLines={1}>
              {outcome.label}
            </Text>
            <View style={styles.rowRight}>
              <Text style={[styles.rowOdds, selected && styles.rowLabelSelected]}>
                {formatEventOdds(outcome.price, oddsFormat)}
              </Text>
              <Text style={styles.rowCents}>{Math.round(outcome.price * 100)}¢</Text>
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

export function ResolutionRulesSheet({
  visible,
  description,
  onClose,
}: {
  visible: boolean;
  description: string | null;
  onClose: () => void;
}) {
  return (
    <Modal transparent visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable
          accessibilityLabel="Close resolution details"
          style={styles.backdropTouch}
          onPress={onClose}
        />
        <View style={styles.sheet}>
          <View style={styles.grabber} />
          <Text style={styles.title}>How this resolves</Text>
          <Text style={styles.body}>
            {description ?? 'Resolution details will appear here when available.'}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Got it"
            style={styles.closeBtn}
            onPress={onClose}>
            <Text style={styles.closeText}>Got it</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 48,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: semantic.border.muted,
    backgroundColor: tokens.colors.surface,
    marginBottom: 6,
  },
  rowSelected: {
    backgroundColor: tokens.colors.lift,
    borderColor: tokens.colors.primary,
  },
  rowLabel: {
    flex: 1,
    fontFamily: 'monospace',
    fontSize: 12,
    color: semantic.text.primary,
    marginRight: 8,
  },
  rowLabelSelected: {
    color: semantic.text.accent,
  },
  rowRight: {
    alignItems: 'flex-end',
    gap: 1,
  },
  rowOdds: {
    fontFamily: 'monospace',
    fontSize: 13,
    fontWeight: '700',
    color: semantic.text.primary,
  },
  rowCents: {
    fontFamily: 'monospace',
    fontSize: 9,
    color: semantic.text.faint,
  },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(3,31,44,.72)',
    justifyContent: 'flex-end',
  },
  backdropTouch: {
    ...StyleSheet.absoluteFillObject,
  },
  sheet: {
    backgroundColor: tokens.colors.ground,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 20,
    paddingTop: 10,
    paddingBottom: 16,
    gap: 8,
  },
  grabber: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 999,
    backgroundColor: semantic.text.faint,
    opacity: 0.6,
    marginBottom: 2,
  },
  title: {
    fontFamily: 'monospace',
    fontSize: 15,
    fontWeight: '800',
    color: semantic.text.primary,
  },
  body: {
    fontFamily: 'monospace',
    fontSize: 11,
    lineHeight: 16,
    color: semantic.text.dim,
  },
  closeBtn: {
    height: 48,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: tokens.colors.primary,
    marginTop: 4,
  },
  closeText: {
    fontFamily: 'monospace',
    fontSize: 13,
    fontWeight: '800',
    color: tokens.colors.bone,
  },
});
