import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import * as Haptics from 'expo-haptics';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { useWalletSheet } from '@/features/wallet/WalletSheetProvider';
import { semantic, tokens } from '@/theme';

/** A visible, app-wide wallet control. Profile identity remains separate. */
export function WalletTrigger() {
  const { openManager, trigger } = useWalletSheet();

  return (
    <Pressable
      onPress={() => {
        if (Platform.OS === 'ios') {
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        }
        openManager();
      }}
      style={({ pressed }) => [styles.touchTarget, pressed && styles.pressed]}
      accessibilityRole="button"
      accessibilityLabel={trigger.accessibilityLabel}
    >
      <View style={[styles.pill, trigger.activeCount === 0 && styles.pillInactive]}>
        <MaterialIcons
          name="account-balance-wallet"
          size={15}
          color={trigger.activeCount > 0 ? semantic.text.accent : semantic.text.dim}
        />
        <Text
          numberOfLines={1}
          style={[styles.label, trigger.activeCount > 0 && styles.labelActive]}
        >
          {trigger.label}
        </Text>
        {trigger.activeCount > 1 ? (
          <View style={styles.countBadge}>
            <Text style={styles.countText}>{trigger.activeCount}</Text>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  touchTarget: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pill: {
    minHeight: 32,
    flexShrink: 0,
    paddingHorizontal: 10,
    borderRadius: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: 'rgba(20,167,125,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(20,167,125,0.28)',
  },
  pillInactive: {
    backgroundColor: semantic.background.lift,
    borderColor: semantic.border.muted,
  },
  label: {
    fontFamily: 'monospace',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.5,
    color: semantic.text.dim,
  },
  labelActive: {
    color: semantic.text.accent,
  },
  countBadge: {
    minWidth: 17,
    height: 17,
    paddingHorizontal: 4,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: tokens.colors.viridian,
  },
  countText: {
    fontFamily: 'monospace',
    fontSize: 9,
    fontWeight: '800',
    color: '#fff',
  },
  pressed: { opacity: 0.74 },
});
