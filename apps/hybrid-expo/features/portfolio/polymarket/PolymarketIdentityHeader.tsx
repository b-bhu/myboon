/**
 * Polymarket portfolio identity header (#736), moved verbatim from
 * `polymarket.portfolio.tsx` (`pageAbove`): the avatar/name row (opens the
 * security settings view, or Polymarket setup when signed out) plus the
 * session-expired and unavailable reconnect banners. Presentational only —
 * the screen passes its existing state, callbacks and settings setters.
 * Pure move — no behaviour change.
 */

import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { Pressable, Text, View } from 'react-native';

import type { PolymarketProfileAccountState } from '@/features/polymarket/portfolio/profile-state';
import type { PolymarketSettingsView } from '@/features/portfolio/polymarket/polymarket.format';
import { styles } from '@/features/portfolio/polymarket/polymarket.portfolio.styles';
import { semantic, tokens } from '@/theme';

export interface PolymarketIdentityHeaderProps {
  accountState: PolymarketProfileAccountState;
  accountStateLabel: string;
  accountStatePositive: boolean;
  displayName: string;
  identitySubtitle: string;
  setupCopy: { title: string; description: string; action: string | null };
  busy: boolean;
  polymarketUnavailable: boolean;
  isEnabled: boolean;
  portfolioLoading: boolean;
  onConnectAccount: () => void;
  onReconnect: () => void;
  setSettingsView: (view: PolymarketSettingsView) => void;
  setSettingsOpen: (open: boolean) => void;
}

export function PolymarketIdentityHeader({
  accountState,
  accountStateLabel,
  accountStatePositive,
  displayName,
  identitySubtitle,
  setupCopy,
  busy,
  polymarketUnavailable,
  isEnabled,
  portfolioLoading,
  onConnectAccount,
  onReconnect,
  setSettingsView,
  setSettingsOpen,
}: PolymarketIdentityHeaderProps) {
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Open account and security"
        style={styles.identity}
        onPress={() => {
          if (accountState === 'signed_out') {
            onConnectAccount();
            return;
          }
          setSettingsView('security');
          setSettingsOpen(true);
        }}>
        <View style={styles.avatarInner}>
          <Text style={styles.avatarText}>{displayName.charAt(0).toUpperCase()}</Text>
          <View style={[styles.avatarStatus, !accountStatePositive && styles.avatarStatusMuted]} />
        </View>
        <View style={styles.identityInfo}>
          <Text style={styles.handle} numberOfLines={1}>{displayName}</Text>
          <Text style={styles.identityMeta} numberOfLines={1}>{identitySubtitle}</Text>
          <View style={styles.identityStateRow}>
            <MaterialIcons
              name={accountStatePositive ? 'verified-user' : accountState === 'session_expired' ? 'sync-problem' : 'shield'}
              size={11}
              color={accountStatePositive ? tokens.colors.viridian : tokens.colors.accent}
            />
            <Text style={[styles.identityStateText, !accountStatePositive && styles.identityStateAttention]}>{accountStateLabel}</Text>
          </View>
        </View>
        <MaterialIcons name="chevron-right" size={20} color={semantic.text.faint} />
      </Pressable>
      {accountState === 'session_expired' ? (
        <Pressable onPress={onReconnect} disabled={busy} style={styles.reconnectBanner}>
          <MaterialIcons name="refresh" size={15} color={tokens.colors.accent} />
          <View style={styles.reconnectCopy}>
            <Text style={styles.reconnectTitle}>{setupCopy.title}</Text>
            <Text style={styles.reconnectText}>{busy ? 'Reconnecting…' : setupCopy.description}</Text>
          </View>
        </Pressable>
      ) : polymarketUnavailable && isEnabled && !portfolioLoading ? (
        <Pressable onPress={onReconnect} disabled={busy} style={styles.reconnectBanner}>
          <MaterialIcons name="refresh" size={14} color={tokens.colors.primary} />
          <Text style={styles.reconnectText}>
            {busy ? 'Retrying…' : 'Could not refresh Polymarket — tap to retry'}
          </Text>
        </Pressable>
      ) : null}
    </>
  );
}
