/**
 * WalletDrawer — account surface for a *connected* user.
 *
 * The drawer deliberately owns no connection path. Connecting happens in one
 * place only: the shared `ConnectionSheet`, opened from the Wallet surface and
 * from the in-context entry points that need a chain. The drawer used to carry
 * its own full Privy login form, which made it a second, divergent route to the
 * same action — and the one users found first. Disconnected, it now shows a
 * prompt that sends the user to the Wallet surface and nothing else.
 *
 * Model: docs/modules/wallet/specs/wallet_connectivity.md ("The connection modal")
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  Keyboard,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import * as Clipboard from 'expo-clipboard';
import Constants from 'expo-constants';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useDrawer } from './DrawerProvider';
import { useWallet } from '@/hooks/useWallet';
import { usePrivyWallet } from '@/hooks/usePrivyWallet';
import { usePolymarketWallet } from '@/hooks/usePolymarketWallet';
import { semantic, tokens } from '@/theme';

const APP_VERSION = Constants.expoConfig?.version ?? '—';

const DRAWER_WIDTH = 280;
const PRIVY_EXPORT_URL = process.env.EXPO_PUBLIC_PRIVY_EXPORT_URL;

export function WalletDrawer() {
  const { isOpen, close } = useDrawer();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { connected, address, source, disconnect: walletDisconnect } = useWallet();
  const privy = usePrivyWallet();
  const poly = usePolymarketWallet();

  const translateX = useRef(new Animated.Value(-DRAWER_WIDTH)).current;
  const overlayOpacity = useRef(new Animated.Value(0)).current;
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setVisible(true);
      Animated.parallel([
        Animated.timing(translateX, {
          toValue: 0,
          duration: 250,
          useNativeDriver: true,
        }),
        Animated.timing(overlayOpacity, {
          toValue: 1,
          duration: 250,
          useNativeDriver: true,
        }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(translateX, {
          toValue: -DRAWER_WIDTH,
          duration: 200,
          useNativeDriver: true,
        }),
        Animated.timing(overlayOpacity, {
          toValue: 0,
          duration: 200,
          useNativeDriver: true,
        }),
      ]).start(() => {
        setVisible(false);
      });
    }
  }, [isOpen, overlayOpacity, translateX]);

  const handleClose = useCallback(() => {
    Keyboard.dismiss();
    close();
  }, [close]);

  const handleCopyAddress = useCallback(async () => {
    if (!address) return;
    await Clipboard.setStringAsync(address);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }, [address]);

  const handleDisconnect = useCallback(() => {
    if (busy) return;
    Alert.alert('Disconnect?', 'You can reconnect anytime.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Disconnect',
        style: 'destructive',
        onPress: async () => {
          setBusy(true);
          try {
            // Clear derived Polymarket session/local state before the base wallet address disappears.
            poly.disable();
            if (source === 'privy') {
              await privy.disconnect();
            } else {
              await walletDisconnect();
            }
            close();
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : 'Failed to disconnect wallet';
            Alert.alert('Disconnect failed', msg);
          } finally {
            setBusy(false);
          }
        },
      },
    ]);
  }, [busy, source, poly, privy, walletDisconnect, close]);

  const handleExportSolanaWallet = useCallback(async () => {
    if (source !== 'privy') {
      Alert.alert('External wallet', 'This Solana wallet is external. Export it from your wallet app.');
      return;
    }
    if (!PRIVY_EXPORT_URL) {
      Alert.alert(
        'Export wallet',
        'Privy Solana wallet export requires a hosted secure export page. Once configured, this button will open that flow.',
      );
      return;
    }
    try {
      const separator = PRIVY_EXPORT_URL.includes('?') ? '&' : '?';
      const url = address
        ? `${PRIVY_EXPORT_URL}${separator}address=${encodeURIComponent(address)}`
        : PRIVY_EXPORT_URL;
      await Linking.openURL(url);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not open wallet export.';
      Alert.alert('Export failed', msg);
    }
  }, [address, source]);

  /**
   * Send the user to the Wallet surface, which owns the connect action.
   *
   * The drawer does not open the connection sheet itself: doing so would keep
   * it a connection entry point under a different name, and leave two surfaces
   * to keep in step. It hands off instead.
   */
  const handleGoToWallet = useCallback(() => {
    Keyboard.dismiss();
    close();
    router.push('/');
  }, [close, router]);

  if (!visible) return null;

  const shortAddr = address
    ? `${address.slice(0, 6)}···${address.slice(-4)}`
    : '—';

  const authLabel =
    privy.authMethod === 'email'
      ? 'Email'
      : privy.authMethod === 'passkey'
        ? 'Passkey'
        : source === 'privy'
          ? 'Privy'
          : 'Wallet';

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      {/* Overlay */}
      <Animated.View style={[styles.overlay, { opacity: overlayOpacity }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={handleClose} />
      </Animated.View>

      {/* Drawer panel */}
      <Animated.View
        style={[
          styles.drawer,
          { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 8 },
          { transform: [{ translateX }] },
        ]}
      >
        {connected ? (
          /* ── CONNECTED STATE ── */
          <>
            <View style={styles.header}>
              <View style={styles.avatarRow}>
                <View style={styles.avatar}>
                  <View style={styles.avatarInner}>
                    <Text style={styles.avatarLetter}>
                      {shortAddr.charAt(0).toUpperCase()}
                    </Text>
                  </View>
                  <View style={styles.avatarDot} />
                </View>
                <View style={styles.identity}>
                  <TouchableOpacity
                    style={styles.addressRow}
                    onPress={handleCopyAddress}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.addressText}>{shortAddr}</Text>
                    <MaterialIcons
                      name="content-copy"
                      size={11}
                      color={semantic.text.faint}
                    />
                  </TouchableOpacity>
                  <View style={styles.authRow}>
                    <View style={styles.authDot} />
                    <Text style={styles.authLabel}>
                      Connected via {authLabel}
                    </Text>
                  </View>
                </View>
              </View>
            </View>

            {/* Predict session expired banner — server session is in-memory and
                gets wiped on restart/redeploy; prompt the user to re-sign
                instead of silently polling a dead session. */}
            {poly.sessionExpired && (
              <TouchableOpacity
                style={styles.sessionExpiredBanner}
                activeOpacity={0.7}
                onPress={() => {
                  poly.enable().catch(() => {});
                }}
              >
                <MaterialIcons name="error-outline" size={14} color="#E0A000" />
                <Text style={styles.sessionExpiredText}>
                  Predict session expired. Tap to reconnect.
                </Text>
              </TouchableOpacity>
            )}

            <View style={styles.drawerSpacer} />

            <View style={styles.footer}>
              {source === 'privy' && (
                <TouchableOpacity
                  onPress={handleExportSolanaWallet}
                  activeOpacity={0.7}
                  style={styles.exportWalletRow}
                >
                  <MaterialIcons
                    name="file-download"
                    size={12}
                    color={semantic.text.dim}
                  />
                  <Text style={styles.exportWalletText}>Export wallet</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity
                onPress={handleDisconnect}
                disabled={busy}
                activeOpacity={0.6}
                style={[styles.disconnectRow, busy && styles.rowDisabled]}
              >
                <MaterialIcons
                  name="power-settings-new"
                  size={12}
                  color={tokens.colors.vermillion}
                />
                <Text style={styles.disconnectText}>
                  {busy ? 'Disconnecting...' : 'Disconnect'}
                </Text>
              </TouchableOpacity>
              <Text style={styles.version}>myboon v{APP_VERSION}</Text>
            </View>
          </>
        ) : (
          /* ── DISCONNECTED STATE ──
             No connect action here. The drawer points at the Wallet surface,
             which opens the one connection sheet in the product. */
          <>
            <View style={styles.connectHeader}>
              <View style={styles.lockAvatar}>
                <View style={styles.lockAvatarInner}>
                  <MaterialIcons
                    name="lock"
                    size={22}
                    color={semantic.text.faint}
                  />
                </View>
              </View>
              <Text style={styles.connectTitle}>Not Connected</Text>
              <Text style={styles.connectSub}>
                Connect a wallet from the Wallet surface to trade, predict, and
                track your portfolio.
              </Text>
            </View>

            <View style={styles.connectActions}>
              <TouchableOpacity
                style={styles.secondaryBtn}
                onPress={handleGoToWallet}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel="Go to Wallet"
              >
                <MaterialIcons
                  name="account-balance-wallet"
                  size={16}
                  color={semantic.text.dim}
                />
                <Text style={styles.secondaryBtnText}>Go to Wallet</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.footer}>
              <Text style={styles.version}>myboon v{APP_VERSION}</Text>
            </View>
          </>
        )}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.6)',
    zIndex: 998,
  },
  drawer: {
    position: 'absolute',
    top: 0,
    left: 0,
    bottom: 0,
    width: DRAWER_WIDTH,
    backgroundColor: semantic.background.screen,
    borderRightWidth: 1,
    borderRightColor: semantic.border.muted,
    zIndex: 999,
    flexDirection: 'column',
  },
  drawerSpacer: {
    flex: 1,
  },

  // ── Connected: Header ──
  header: {
    paddingHorizontal: 20,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: semantic.border.muted,
  },
  avatarRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 2,
    borderColor: tokens.colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  avatarInner: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: semantic.background.lift,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarLetter: {
    fontFamily: 'monospace',
    fontSize: 14,
    fontWeight: '700',
    color: tokens.colors.primary,
  },
  avatarDot: {
    position: 'absolute',
    top: -1,
    right: -1,
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: tokens.colors.viridian,
    borderWidth: 2.5,
    borderColor: semantic.background.screen,
  },
  identity: {
    flex: 1,
  },
  addressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  addressText: {
    fontFamily: 'monospace',
    fontSize: 12,
    fontWeight: '600',
    color: semantic.text.primary,
    letterSpacing: 0.3,
  },
  authRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginTop: 5,
  },
  authDot: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: tokens.colors.viridian,
  },
  authLabel: {
    fontFamily: 'monospace',
    fontSize: 8,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    color: tokens.colors.viridian,
  },

  sessionExpiredBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginHorizontal: 20,
    marginTop: 12,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 8,
    backgroundColor: 'rgba(224, 160, 0, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(224, 160, 0, 0.3)',
  },
  sessionExpiredText: {
    flex: 1,
    fontFamily: 'monospace',
    fontSize: 10,
    color: '#E0A000',
  },

  // ── Footer ──
  footer: {
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderTopWidth: 1,
    borderTopColor: semantic.border.muted,
    alignItems: 'center',
    gap: 8,
  },
  disconnectRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 4,
  },
  rowDisabled: {
    opacity: 0.5,
  },
  exportWalletRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 4,
  },
  exportWalletText: {
    fontFamily: 'monospace',
    fontSize: 9,
    fontWeight: '600',
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: semantic.text.dim,
  },
  disconnectText: {
    fontFamily: 'monospace',
    fontSize: 9,
    fontWeight: '600',
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: tokens.colors.vermillion,
  },
  version: {
    fontFamily: 'monospace',
    fontSize: 8,
    letterSpacing: 2,
    textTransform: 'uppercase',
    color: semantic.text.faint,
  },

  // ── Disconnected ──
  connectHeader: {
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingBottom: 16,
    gap: 10,
  },
  lockAvatar: {
    width: 56,
    height: 56,
    borderRadius: 28,
    borderWidth: 2,
    borderColor: semantic.text.faint,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
  },
  lockAvatarInner: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: semantic.background.lift,
    alignItems: 'center',
    justifyContent: 'center',
  },
  connectTitle: {
    fontFamily: 'monospace',
    fontSize: 11,
    letterSpacing: 2.5,
    textTransform: 'uppercase',
    color: semantic.text.primary,
  },
  connectSub: {
    fontFamily: 'monospace',
    fontSize: 9,
    color: semantic.text.faint,
    textAlign: 'center',
    lineHeight: 15,
    letterSpacing: 0.3,
    maxWidth: 220,
  },

  connectActions: {
    paddingHorizontal: 20,
    gap: 8,
    flex: 1,
  },
  secondaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: semantic.border.muted,
    borderRadius: 10,
    paddingVertical: 11,
  },
  secondaryBtnText: {
    fontFamily: 'monospace',
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: semantic.text.dim,
  },
});
