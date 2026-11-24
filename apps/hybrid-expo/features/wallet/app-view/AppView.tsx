/**
 * Wallet app view shell (issue #771, design wallet.html "App view").
 *
 * The shell mounts over the Portfolio panel when an app is selected: a back
 * control that returns to the Portfolio list and the app's title. The
 * The per-app content (stats, Deposit | Withdraw strip, Positions | Orders |
 * History) plugs in under the shell in later issues. Nothing dispatches
 * `select` yet (#856), so the shell never shows on screen for now; the
 * Meteora app view carries its top block (#852) already.
 *
 * Generic by app id: today's ids are the Wallet protocol ids
 * (`WalletProtocolId`), and an unknown id falls back to the raw id for the
 * title so a future app cannot crash the shell.
 */

import { memo } from 'react';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { swapTheme as color } from '@/features/swap/swap.theme';
import { MeteoraAppTop } from './MeteoraAppTop';

/** Display titles for the known Wallet apps; unknown ids fall back to the id. */
const APP_TITLES: Readonly<Record<string, string>> = {
  polymarket: 'Polymarket',
  phoenix: 'Phoenix',
  pacifica: 'Pacifica',
  meteora: 'Meteora',
  spot: 'Spot',
};

export function appViewTitle(app: string): string {
  return APP_TITLES[app] ?? app;
}

export const AppView = memo(function AppView({
  app,
  solana,
  evm,
  onBack,
  style,
}: {
  /** The selected app id; titles resolve from it so callers stay generic. */
  app: string;
  /** Wallet addresses for the app's summary call (#852). */
  solana: string | null;
  evm: string | null;
  /** Back to the Portfolio list (#771). */
  onBack: () => void;
  /** Positioning from the mount point — the shell overlays the Portfolio. */
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[styles.shell, style]}>
      <View style={styles.header}>
        <Pressable
          onPress={onBack}
          accessibilityRole="button"
          accessibilityLabel="Back to Portfolio"
          hitSlop={8}
          style={styles.back}
        >
          <MaterialIcons name="arrow-back" size={24} color={color.text} />
        </Pressable>
        <Text numberOfLines={1} accessibilityRole="header" style={styles.title}>
          {appViewTitle(app)}
        </Text>
      </View>
      {/* Meteora top block (#852): the other apps' blocks plug in later. */}
      {app === 'meteora' ? <MeteoraAppTop solana={solana} evm={evm} /> : null}
    </View>
  );
});

const styles = StyleSheet.create({
  // Fills the surface the mount point gives it; the Wallet shell passes an
  // absolute fill over the Portfolio panel.
  shell: {
    flex: 1,
    backgroundColor: color.navy,
    paddingHorizontal: 14,
    paddingTop: 10,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  back: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1, color: color.text, fontSize: 20, fontWeight: '600' },
});
