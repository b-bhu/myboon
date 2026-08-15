/**
 * AppProfileButton — the right-top affordance inside an application.
 *
 * Application roots keep profile identity separate from the adjacent global
 * wallet control. Home has no venue profile and shows only the wallet control.
 *
 * The border carries connection state: green when a wallet is connected, muted
 * when not. That is the only signal — the icon itself never changes, so the
 * control keeps a stable shape and position across states.
 *
 * Apps with their own palette (Meteora) pass `borderColor` / `iconColor` to
 * match their surface. The connected treatment overrides `borderColor` so the
 * signal is consistent everywhere.
 */

import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { Pressable, StyleSheet, View } from 'react-native';
import { semantic, tokens } from '@/theme';

export function AppProfileButton({
  onPress,
  connected,
  label = 'Open profile',
  hint,
  borderColor,
  iconColor,
  backgroundColor,
}: {
  onPress: () => void;
  /** Drives the border treatment. */
  connected: boolean;
  accessibilityLabel?: string;
  label?: string;
  hint?: string;
  /** Disconnected border, for apps with their own palette. */
  borderColor?: string;
  iconColor?: string;
  backgroundColor?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      hitSlop={8}
      style={({ pressed }) => [styles.button, pressed && styles.pressed]}
    >
      <View
        style={[
          styles.iconFrame,
          !!backgroundColor && { backgroundColor },
          !!borderColor && { borderColor },
          connected && styles.iconFrameConnected,
        ]}
      >
        <MaterialIcons
          name="person-outline"
          size={17}
          color={iconColor ?? semantic.text.dim}
        />
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
    borderColor: semantic.border.muted,
    backgroundColor: semantic.background.lift,
  },
  iconFrameConnected: {
    borderColor: tokens.colors.viridian,
  },
  pressed: {
    opacity: 0.68,
  },
});
