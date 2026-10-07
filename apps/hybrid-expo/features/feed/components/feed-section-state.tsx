import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { FEED_COLORS as color } from '../feed.constants';

export function FeedSectionState({ title, text, loading, onRetry }: {
  title: string; text?: string; loading?: boolean; onRetry?: () => void;
}) {
  return <View style={styles.state} accessibilityLiveRegion="polite">
    {loading ? <ActivityIndicator color={color.accent} /> : null}
    <Text selectable style={styles.title}>{title}</Text>
    {text ? <Text selectable style={styles.text}>{text}</Text> : null}
    {onRetry ? <Pressable onPress={onRetry} accessibilityRole="button" accessibilityLabel={`Retry ${title}`} style={styles.retry}>
      <Text style={styles.action}>Try again</Text>
    </Pressable> : null}
  </View>;
}

export const styles = StyleSheet.create({
  state: { padding: 14, gap: 8, backgroundColor: color.card, borderWidth: 1, borderColor: color.border, borderRadius: 8 },
  title: { color: color.text, fontSize: 15, fontWeight: '700', lineHeight: 21 },
  text: { color: color.textDim, fontSize: 13, lineHeight: 19 },
  retry: { minHeight: 44, alignSelf: 'flex-start', justifyContent: 'center', paddingHorizontal: 8 },
  action: { color: color.accent, fontSize: 13, fontWeight: '700' },
});
