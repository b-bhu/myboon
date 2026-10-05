import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { Pressable, StyleSheet, View } from 'react-native';
import { METEORA_COLORS } from '@/features/meteora/meteora.theme';

export function MeteoraProfileButton({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="Open Meteora profile"
      accessibilityHint="View your Meteora positions, orders, and history"
      hitSlop={8}
      style={({ pressed }) => [styles.button, pressed && styles.pressed]}
    >
      <View style={styles.iconFrame}>
        <MaterialIcons name="person-outline" size={17} color={METEORA_COLORS.text} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    width: 44,
    height: 44,
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  iconFrame: {
    width: 30,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 15,
    borderWidth: 1,
    borderColor: METEORA_COLORS.border,
    backgroundColor: METEORA_COLORS.surfaceRaised,
  },
  pressed: {
    opacity: 0.68,
  },
});
