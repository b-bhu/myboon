import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { WalletTrigger } from '@/components/WalletTrigger';
import { FEED_COLORS } from '@/features/feed/feed.constants';

export function FeedHeader() {
  const router = useRouter();

  return (
    <View style={styles.header}>
      <Pressable
        onPress={() => router.back()}
        accessibilityRole="button"
        accessibilityLabel="Back to Home"
        style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}
      >
        <MaterialIcons name="arrow-back" size={19} color={FEED_COLORS.text} />
      </Pressable>
      <Text style={styles.title}>Feed</Text>
      <WalletTrigger />
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    minHeight: 50,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: FEED_COLORS.border,
    backgroundColor: FEED_COLORS.screen,
  },
  backButton: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: FEED_COLORS.cardDeep,
  },
  title: {
    position: 'absolute',
    left: 70,
    right: 70,
    color: FEED_COLORS.text,
    fontSize: 21,
    lineHeight: 28,
    fontWeight: '900',
    textAlign: 'center',
  },
  pressed: {
    opacity: 0.72,
  },
});
