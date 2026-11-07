import { StyleSheet, Text, View } from 'react-native';
import { semantic, tokens } from '@/theme';

interface StatsStripProps {
  stats: { value: string; label: string }[];
}

export function StatsStrip({ stats }: StatsStripProps) {
  return (
    <View style={styles.container}>
      {stats.map((s) => (
        <View key={s.label} style={styles.item}>
          <Text style={styles.value}>{s.value}</Text>
          <Text style={styles.label}>{s.label}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  item: {
    flex: 1,
    alignItems: 'center',
  },
  value: {
    fontFamily: 'monospace',
    fontSize: 13,
    fontWeight: '700',
    color: semantic.text.primary,
    lineHeight: 16,
  },
  label: {
    fontFamily: 'monospace',
    fontSize: 7,
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: semantic.text.dim,
    marginTop: 3,
  },
});
