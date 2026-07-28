import { useLocalSearchParams } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { PositionDetailScreen } from '@/features/predict/profile/PositionDetailScreen';
import { semantic, tokens } from '@/theme';

export default function PredictPositionDetailRoute() {
  const params = useLocalSearchParams<{
    conditionId?: string;
    slug?: string;
    outcomeIndex?: string;
  }>();

  const conditionId = typeof params.conditionId === 'string' ? params.conditionId : '';
  const slug = typeof params.slug === 'string' ? params.slug : '';
  const outcomeIndex = typeof params.outcomeIndex === 'string' ? parseInt(params.outcomeIndex, 10) : 0;

  if (!conditionId) {
    return (
      <View style={styles.screen}>
        <Text style={styles.text}>Invalid position</Text>
      </View>
    );
  }

  return (
    <PositionDetailScreen
      conditionId={conditionId}
      slug={slug}
      outcomeIndex={outcomeIndex}
    />
  );
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
