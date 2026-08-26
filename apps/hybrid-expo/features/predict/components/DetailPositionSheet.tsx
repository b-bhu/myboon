import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import type { PortfolioPosition } from '@/features/predict/predict.api';
import { semantic, tokens } from '@/theme';

interface DetailPositionSheetProps {
  visible: boolean;
  position: PortfolioPosition | null;
  title: string;
  onClose: () => void;
  onAdd: () => void;
  onCashOut: () => void;
}

function money(value: number): string {
  return `$${value.toFixed(2)}`;
}

function signedMoney(value: number): string {
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

export function DetailPositionSheet({
  visible,
  position,
  title,
  onClose,
  onAdd,
  onCashOut,
}: DetailPositionSheetProps) {
  if (!position) return null;
  const putIn = position.size * position.avgPrice;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} accessibilityLabel="Close your pick" onPress={onClose} />
        <View style={styles.sheet} accessibilityViewIsModal>
          <View style={styles.grabber} />
          <View style={styles.header}>
            <Text style={styles.heading}>Your pick</Text>
            <Pressable style={styles.close} accessibilityRole="button" accessibilityLabel="Close your pick" onPress={onClose}>
              <MaterialIcons name="close" size={19} color={semantic.text.dim} />
            </Pressable>
          </View>
          <View style={styles.hero}>
            <View style={styles.heroCopy}>
              <Text style={styles.outcome}>{position.outcome}</Text>
              <Text style={styles.title} numberOfLines={2}>{title}</Text>
            </View>
            <Text style={[styles.pnl, position.cashPnl < 0 && styles.pnlNegative]}>{signedMoney(position.cashPnl)}</Text>
          </View>
          <View style={styles.grid}>
            <View style={styles.stat}><Text style={styles.statLabel}>Put in</Text><Text style={styles.statValue}>{money(putIn)}</Text></View>
            <View style={styles.stat}><Text style={styles.statLabel}>Entry</Text><Text style={styles.statValue}>{Math.round(position.avgPrice * 100)}¢</Text></View>
            <View style={styles.stat}><Text style={styles.statLabel}>Now</Text><Text style={styles.statValue}>{Math.round(position.curPrice * 100)}¢</Text></View>
            <View style={styles.stat}><Text style={styles.statLabel}>Value</Text><Text style={styles.statValue}>{money(position.currentValue)}</Text></View>
          </View>
          <View style={styles.actions}>
            <Pressable style={styles.secondary} accessibilityRole="button" onPress={onAdd}>
              <Text style={styles.secondaryText}>Add to pick</Text>
            </Pressable>
            <Pressable style={styles.primary} accessibilityRole="button" onPress={onCashOut}>
              <Text style={styles.primaryText}>Cash out {money(position.currentValue)}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(3,31,44,0.76)' },
  sheet: { paddingHorizontal: 16, paddingTop: 10, paddingBottom: 24, borderTopLeftRadius: 28, borderTopRightRadius: 28, borderCurve: 'continuous', borderWidth: 1, borderBottomWidth: 0, borderColor: semantic.border.muted, backgroundColor: tokens.colors.ground },
  grabber: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, backgroundColor: semantic.border.muted },
  header: { minHeight: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  heading: { fontSize: 18, fontWeight: '900', color: semantic.text.primary },
  close: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: tokens.colors.surface },
  hero: { paddingTop: 10, flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12 },
  heroCopy: { flex: 1 },
  outcome: { fontFamily: 'monospace', fontSize: 9, fontWeight: '900', textTransform: 'uppercase', color: tokens.colors.viridian },
  title: { paddingTop: 6, fontSize: 18, lineHeight: 22, fontWeight: '900', color: semantic.text.primary },
  pnl: { fontFamily: 'monospace', fontSize: 27, fontWeight: '900', letterSpacing: -1.5, color: tokens.colors.viridian },
  pnlNegative: { color: tokens.colors.vermillion },
  grid: { paddingTop: 18, flexDirection: 'row', gap: 5 },
  stat: { flex: 1, minHeight: 60, paddingHorizontal: 7, paddingVertical: 10, borderRadius: 11, borderCurve: 'continuous', borderWidth: 1, borderColor: semantic.border.muted, backgroundColor: tokens.colors.surface },
  statLabel: { fontFamily: 'monospace', fontSize: 8, textTransform: 'uppercase', color: semantic.text.faint },
  statValue: { paddingTop: 9, fontFamily: 'monospace', fontSize: 10, fontWeight: '900', fontVariant: ['tabular-nums'], color: semantic.text.primary },
  actions: { paddingTop: 10, flexDirection: 'row', gap: 8 },
  secondary: { flex: 1, minHeight: 46, borderRadius: 12, borderCurve: 'continuous', borderWidth: 1, borderColor: semantic.border.muted, alignItems: 'center', justifyContent: 'center', backgroundColor: tokens.colors.surface },
  secondaryText: { fontSize: 10, fontWeight: '900', color: semantic.text.primary },
  primary: { flex: 1.35, minHeight: 46, borderRadius: 12, borderCurve: 'continuous', alignItems: 'center', justifyContent: 'center', backgroundColor: tokens.colors.viridian },
  primaryText: { fontSize: 10, fontWeight: '900', color: tokens.colors.backgroundDark },
});
