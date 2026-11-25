/**
 * The action panel body when no wallet is connected — issue #804, frame
 * "Wallet · not connected" (docs/design/wallet.html): a lock, "Connect to
 * MyBoon", one line, and a gold Connect button, in the same fixed 430px frame.
 * The Connect button opens the wallet sheet through `onConnect`.
 */

import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { tokens } from '@/theme';
import { WALLET_ACTION_BODY_HEIGHT } from '@/features/wallet/wallet-mode';

export const NOT_CONNECTED_TITLE = 'Connect to MyBoon';
export const NOT_CONNECTED_BODY = 'Connect a wallet to swap, move, send and receive.';

export function WalletNotConnectedPanel({ onConnect }: { onConnect: () => void }) {
  return (
    <View style={styles.body}>
      <MaterialIcons name="lock-outline" size={32} color={tokens.colors.textFaint} />
      <Text style={styles.title}>{NOT_CONNECTED_TITLE}</Text>
      <Text style={styles.text}>{NOT_CONNECTED_BODY}</Text>
      <Pressable
        onPress={onConnect}
        accessibilityRole="button"
        accessibilityLabel="Connect wallet"
        style={({ pressed }) => [styles.button, pressed && styles.pressed]}
      >
        <Text style={styles.buttonLabel}>Connect</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  body: {
    height: WALLET_ACTION_BODY_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  title: { marginTop: 12, marginBottom: 4, fontSize: 18, fontWeight: '600', color: tokens.colors.bone },
  text: { maxWidth: 260, marginBottom: 16, textAlign: 'center', fontSize: 14, color: tokens.colors.textDim },
  button: {
    height: 44,
    paddingHorizontal: 28,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: tokens.colors.primaryDim,
  },
  buttonLabel: { fontSize: 15, fontWeight: '600', color: '#021B26' },
  pressed: { opacity: 0.7 },
});
