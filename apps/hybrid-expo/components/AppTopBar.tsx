import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useRouter } from 'expo-router';
import type { ComponentProps, ReactNode } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { semantic, tokens } from '@/theme';

type MaterialIconName = ComponentProps<typeof MaterialIcons>['name'];

interface AppTopBarProps {
  left?: ReactNode;
  center?: ReactNode;
  right?: ReactNode;
}

interface AppTopBarTitleProps {
  children: ReactNode;
  align?: 'left' | 'center';
  numberOfLines?: number;
  tone?: 'dim' | 'primary';
  uppercase?: boolean;
}

interface AppTopBarIconButtonProps {
  icon: MaterialIconName;
  onPress?: () => void;
  accessibilityLabel: string;
  color?: string;
  size?: number;
}

export function AppTopBarActions({ children }: { children: ReactNode }) {
  return <View style={styles.actions}>{children}</View>;
}

export function AppTopBar({ left, center, right }: AppTopBarProps) {
  return (
    <View style={styles.bar}>
      <View style={styles.leftSlot}>{left}</View>
      <View style={styles.centerSlot}>{center}</View>
      <View style={styles.rightSlot}>{right}</View>
    </View>
  );
}

export function AppTopBarLogo() {
  const router = useRouter();

  return (
    <Pressable
      onPress={() => router.replace('/')}
      accessibilityRole="button"
      accessibilityLabel="Go to Home"
      hitSlop={8}
    >
      <Image
        source={require('../assets/branding/myboon-wordmark-header.png')}
        style={styles.logo}
        resizeMode="contain"
      />
    </Pressable>
  );
}

export function AppTopBarTitle({
  children,
  align = 'center',
  numberOfLines = 1,
  tone = 'dim',
  uppercase = true,
}: AppTopBarTitleProps) {
  return (
    <Text
      style={[
        styles.title,
        tone === 'primary' && styles.titlePrimary,
        !uppercase && styles.titleNatural,
        align === 'left' && styles.titleLeft,
      ]}
      numberOfLines={numberOfLines}
    >
      {children}
    </Text>
  );
}

export function AppTopBarIconButton({
  icon,
  onPress,
  accessibilityLabel,
  color = semantic.text.primary,
  size = 16,
}: AppTopBarIconButtonProps) {
  return (
    <Pressable
      onPress={onPress}
      style={styles.iconButton}
      accessibilityLabel={accessibilityLabel}
    >
      <MaterialIcons name={icon} size={size} color={color} />
    </Pressable>
  );
}

export function AppTopBarProfileButton({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={styles.profileButton}
      accessibilityRole="button"
      accessibilityLabel="Go to Profile"
      hitSlop={8}
    >
      <Text style={styles.profileButtonText}>Profile</Text>
    </Pressable>
  );
}

export function AppTopBarCashPill({ value }: { value: string }) {
  return (
    <View style={styles.cashPill}>
      <Text style={styles.cashPillLabel}>Cash</Text>
      <Text style={styles.cashPillValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: tokens.spacing.lg,
    paddingVertical: 4,
    gap: 10,
    backgroundColor: semantic.background.screen,
  },
  leftSlot: {
    flexShrink: 0,
    alignItems: 'flex-start',
    justifyContent: 'center',
  },
  centerSlot: {
    flex: 1,
    minWidth: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rightSlot: {
    flexShrink: 0,
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 2,
  },
  logo: {
    width: tokens.sizing.headerLogoWidth,
    height: tokens.sizing.headerLogoHeight,
  },
  title: {
    width: '100%',
    textAlign: 'center',
    color: semantic.text.dim,
    fontSize: tokens.fontSize.xs,
    letterSpacing: 2.2,
    textTransform: 'uppercase',
    fontFamily: 'monospace',
    fontWeight: '700',
  },
  titlePrimary: {
    color: semantic.text.primary,
  },
  titleNatural: {
    textTransform: 'none',
    letterSpacing: 0.2,
  },
  titleLeft: {
    textAlign: 'left',
  },
  iconButton: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: semantic.background.lift,
    alignItems: 'center',
    justifyContent: 'center',
  },
  profileButton: {
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  profileButtonText: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xs,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    fontWeight: '700',
    color: semantic.text.primary,
  },
  cashPill: {
    minHeight: 26,
    borderRadius: 13,
    backgroundColor: semantic.background.lift,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
    paddingVertical: 3,
    flexShrink: 0,
  },
  cashPillLabel: {
    fontFamily: 'monospace',
    fontSize: 6,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    color: semantic.text.faint,
  },
  cashPillValue: {
    fontFamily: 'monospace',
    fontSize: 9.5,
    fontWeight: '800',
    color: semantic.text.primary,
  },
});
