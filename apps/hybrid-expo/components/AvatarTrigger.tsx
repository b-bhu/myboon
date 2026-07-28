/**
 * AvatarTrigger — opens the wallet sheet from any header.
 *
 * Previously opened the side drawer. The drawer is gone; the sheet is the one
 * place wallet connection state is presented, so the avatar goes there.
 */

import React from 'react';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { useWalletSheet } from '@/features/wallet/WalletSheetProvider';
import { useWallet } from '@/hooks/useWallet';
import { semantic, tokens } from '@/theme';

export function AvatarTrigger({ onPress }: { onPress?: () => void }) {
  const { open } = useWalletSheet();
  const { connected, shortAddress } = useWallet();

  const letter = shortAddress ? shortAddress.charAt(0).toUpperCase() : 'U';

  return (
    <Pressable
      onPress={() => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        (onPress ?? open)();
      }}
      style={styles.trigger}
    >
      <View style={[styles.ring, !connected && styles.ringDisconnected]}>
        <View style={styles.inner}>
          {connected ? (
            <Text style={styles.letter}>{letter}</Text>
          ) : (
            <MaterialIcons name="account-balance-wallet" size={12} color={semantic.text.dim} />
          )}
        </View>
      </View>
      {connected && <View style={styles.dot} />}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  trigger: {
    width: 30,
    height: 30,
    position: 'relative',
  },
  ring: {
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: 1.5,
    borderColor: tokens.colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ringDisconnected: {
    borderColor: semantic.text.dim,
    borderStyle: 'dashed',
  },
  inner: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: semantic.background.lift,
    alignItems: 'center',
    justifyContent: 'center',
  },
  letter: {
    fontFamily: 'monospace',
    fontSize: 10,
    fontWeight: '700',
    color: tokens.colors.primary,
  },
  dot: {
    position: 'absolute',
    top: -1,
    right: -1,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: tokens.colors.viridian,
    borderWidth: 2,
    borderColor: semantic.background.screen,
  },
});
