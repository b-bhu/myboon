import { useLocalSearchParams } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { PolymarketMarketDetailScreen } from '@/features/polymarket/PolymarketMarketDetailScreen';
import { semantic, tokens } from '@/theme';

export default function PolymarketMarketDetailRoute() {
  const params = useLocalSearchParams<{ slug?: string }>();
  const slug = typeof params.slug === 'string' ? params.slug : '';

  if (!slug) {
    return (
      <View style={styles.screen}>
        <Text style={styles.text}>Invalid market slug</Text>
      </View>
    );
  }

  return <PolymarketMarketDetailScreen slug={slug} />;
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: semantic.background.screen,
    padding: tokens.spacing.lg,
  },
  text: {
    color: semantic.text.primary,
    fontSize: tokens.fontSize.md,
  },
});
