/**
 * ConnectionSheetParts — the sheet's small presentational blocks.
 *
 * Moved out of ConnectionSheet.tsx (#737): the wait and fail blocks, the three
 * buttons, and the email/wallet marks. Presentation only, no state and no
 * behaviour of its own; the sheet decides which of these it renders.
 *
 * Model: docs/modules/wallet/specs/wallet_connectivity.md ("The connection modal")
 */

import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import { tokens } from '@/theme';
import { styles } from '@/features/wallet/components/ConnectionSheet.styles';

export function WaitBlock({ title, body }: { title: string; body: string }) {
  return (
    <View style={styles.wait}>
      <ActivityIndicator size="small" color={tokens.colors.viridian} />
      <Text style={styles.waitTitle}>{title}</Text>
      {body ? <Text style={styles.waitBody}>{body}</Text> : null}
    </View>
  );
}

export function FailBlock({
  title,
  body,
  icon = true,
  children,
}: {
  title: string;
  body: string;
  icon?: boolean;
  children: ReactNode;
}) {
  return (
    <View style={styles.fail}>
      {icon ? (
        <View style={styles.failIcon}>
          <MaterialIcons name="error-outline" size={22} color={tokens.colors.vermillion} />
        </View>
      ) : null}
      <Text style={styles.waitTitle}>{title}</Text>
      <Text style={styles.waitBody}>{body}</Text>
      {children}
    </View>
  );
}

export function PrimaryButton({
  label,
  onPress,
  disabled,
  busy,
  compact = false,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
  compact?: boolean;
}) {
  const off = disabled || busy;
  return (
    <Pressable
      style={({ pressed }) => [
        styles.primaryBtn,
        compact && styles.primaryBtnCompact,
        off && styles.disabled,
        pressed && !off && styles.pressed,
      ]}
      disabled={off}
      onPress={onPress}
      accessibilityRole="button"
    >
      {busy ? (
        <ActivityIndicator size="small" color={tokens.colors.walletCore} />
      ) : (
        <Text style={styles.primaryText}>{label}</Text>
      )}
    </Pressable>
  );
}

export function SecondaryButton({
  label,
  onPress,
  disabled,
  compact = false,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  return (
    <Pressable
      style={({ pressed }) => [
        styles.secondaryBtn,
        compact && styles.secondaryBtnCompact,
        disabled && styles.disabled,
        pressed && !disabled && styles.pressed,
      ]}
      disabled={disabled}
      onPress={onPress}
      accessibilityRole="button"
    >
      <Text style={styles.secondaryText}>{label}</Text>
    </Pressable>
  );
}

export function DangerButton({
  label,
  onPress,
  disabled,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      style={({ pressed }) => [styles.dangerBtn, disabled && styles.disabled, pressed && !disabled && styles.pressed]}
      disabled={disabled}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Text style={styles.dangerText}>{label}</Text>
    </Pressable>
  );
}

export function EmailMark({ color, size = 20 }: { color: string; size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M3.5 7.5A2.5 2.5 0 0 1 6 5h12a2.5 2.5 0 0 1 2.5 2.5v9A2.5 2.5 0 0 1 18 19H6a2.5 2.5 0 0 1-2.5-2.5v-9Z"
        stroke={color}
        strokeWidth={1.75}
      />
      <Path
        d="m4.5 8 6.7 5.1a1.5 1.5 0 0 0 1.8 0L19.5 8"
        stroke={color}
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

export function WalletMark({ color, size = 20 }: { color: string; size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M19 7V5a2 2 0 0 0-2-2H6a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3h13a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2H6a1 1 0 0 1 0-2"
        stroke={color}
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path
        d="M21 12h-5v5h5"
        stroke={color}
        strokeWidth={1.75}
        strokeLinejoin="round"
      />
      <Circle cx={17.5} cy={14.5} r={0.75} fill={color} />
    </Svg>
  );
}
