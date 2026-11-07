import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FeedHeader } from '@/features/feed/components/FeedHeader';
import { semantic, tokens } from '@/theme';

interface SectionPlaceholderScreenProps {
  title: 'Polymarket' | 'Swap' | 'Trade';
}

export function SectionPlaceholderScreen({ title }: SectionPlaceholderScreenProps) {
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <FeedHeader />
      <View style={styles.body}>
        <View style={styles.card}>
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.description}>This section is coming next.</Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: semantic.background.screen,
  },
  body: {
    flex: 1,
    padding: tokens.spacing.lg,
    justifyContent: 'center',
  },
  card: {
    backgroundColor: semantic.background.surface,
    borderWidth: 1,
    borderColor: semantic.border.muted,
    borderRadius: tokens.radius.md,
    padding: tokens.spacing.xl,
    gap: tokens.spacing.sm,
  },
  title: {
    color: semantic.text.primary,
    fontSize: tokens.fontSize.lg,
    fontWeight: '700',
  },
  description: {
    color: semantic.text.dim,
    fontSize: tokens.fontSize.md,
  },
});
