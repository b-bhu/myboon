/**
 * ReceivePanel — the Wallet's Receive mode (issue #719, design wallet.html
 * `.qrcard`; #821 matches the mock's strip and Copy label).
 *
 * One QR card for the address the Solana | EVM toggle picks; the card holds
 * only the toggle, the QR and the address. Below it, where the slider sits
 * in the other modes, a two-line strip (mock `.dstrip`) and the 54px Copy
 * button (mock `.copybtn`); the card is flex and absorbs the strip's height.
 * Nothing is signed in Receive, so there is no swipe and the panel body
 * geometry does not change.
 *
 * The QR encodes the raw address string, not a payment URI, so a scan with
 * another wallet app resolves to the same address the card shows. One 0x
 * address serves every EVM chain, so the EVM label is just "EVM" — never a
 * single chain's name.
 *
 * State comes from `receivePanelState` (pure, tested): a connected chain shows
 * the QR card, an active EVM chain without an embedded wallet says "not set
 * up yet", and everything else gets a connect prompt that opens the Wallet
 * connection sheet for that chain. The strip text and the Copy label come
 * from `receivePanelCopy` (pure, tested).
 */

import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import type { Chain } from '@/features/chain/chain.contract';
import { tokens } from '@/theme';
import { useWalletSheet } from '@/features/wallet/WalletSheetProvider';
import {
  receivePanelCopy,
  receivePanelState,
  type ReceiveChain,
  type ReceivePanelStateName,
} from '@/features/wallet/components/receive-panel-state';

const NETWORK_LABEL: Record<ReceiveChain, string> = {
  solana: 'Solana',
  evm: 'EVM',
};

function NetworkToggle({ chain, onSelect }: { chain: ReceiveChain; onSelect: (chain: ReceiveChain) => void }) {
  return (
    <View style={styles.toggle}>
      {(['solana', 'evm'] as const).map((id) => (
        <Pressable
          key={id}
          accessibilityRole="tab"
          accessibilityLabel={`${NETWORK_LABEL[id]} address`}
          accessibilityState={{ selected: chain === id }}
          onPress={() => onSelect(id)}
          style={[styles.toggleSegment, chain === id && styles.toggleSegmentOn]}
        >
          <Text style={[styles.toggleLabel, chain === id && styles.toggleLabelOn]}>{id}</Text>
        </Pressable>
      ))}
    </View>
  );
}

function ConnectPrompt({ chain }: { chain: ReceiveChain }) {
  const { open } = useWalletSheet();
  const network = NETWORK_LABEL[chain];
  return (
    <View style={styles.note}>
      <Text style={styles.noteTitle}>{network} is not connected</Text>
      <Text style={styles.noteBody}>Connect a wallet to get your receive address.</Text>
      <Pressable
        onPress={() => open(chain)}
        accessibilityRole="button"
        accessibilityLabel={`Connect ${network} wallet`}
        style={({ pressed }) => [styles.connect, pressed && styles.pressed]}
      >
        <Text style={styles.connectLabel}>Connect</Text>
      </Pressable>
    </View>
  );
}

function DormantNote({ network }: { network: string }) {
  return (
    <View style={styles.note}>
      <Text style={styles.noteTitle}>{network} is not set up yet</Text>
      <Text style={styles.noteBody}>
        The EVM wallet has not been created on this device, so there is no
        address to receive on yet.
      </Text>
    </View>
  );
}

export function ReceivePanel({ solanaAddress, evmAddress, chains }: {
  solanaAddress: string | null;
  evmAddress: string | null;
  chains: readonly Chain[];
}) {
  const [chain, setChain] = useState<ReceiveChain>('solana');
  const [copied, setCopied] = useState(false);
  const address = chain === 'solana' ? solanaAddress : evmAddress;
  const state: ReceivePanelStateName = receivePanelState({
    chain,
    solanaAddress,
    evmAddress,
    activeChains: chains,
  });
  const network = NETWORK_LABEL[chain];
  const copy = receivePanelCopy(chain);

  const handleCopy = useCallback(async () => {
    if (!address) return;
    await Clipboard.setStringAsync(address);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [address]);

  return (
    <View style={styles.body}>
      <View style={styles.card}>
        <NetworkToggle chain={chain} onSelect={setChain} />
        {state === 'connected' && address !== null ? (
          <View style={styles.qrBody} accessibilityLabel={`${network} receive address`}>
            <View style={styles.qrTile}>
              <QRCode value={address} size={126} color={tokens.colors.walletCore} backgroundColor="transparent" />
            </View>
            <Text selectable style={styles.addr}>{address}</Text>
          </View>
        ) : null}
        {state === 'dormant-evm' ? <DormantNote network={network} /> : null}
        {state === 'not-connected' ? <ConnectPrompt chain={chain} /> : null}
      </View>
      {state === 'connected' ? (
        <>
          <View style={styles.dstrip}>
            <Text style={styles.dstripLine}>{copy.strip[0]}</Text>
            <Text style={styles.dstripLine}>{copy.strip[1]}</Text>
          </View>
          <Pressable
            onPress={handleCopy}
            accessibilityRole="button"
            accessibilityLabel={copy.copyLabel}
            style={({ pressed }) => [styles.copy, pressed && styles.pressed]}
          >
            <MaterialIcons
              name={copied ? 'check' : 'content-copy'}
              size={16}
              color={copied ? tokens.colors.viridian : tokens.colors.accent}
            />
            <Text style={[styles.copyLabel, copied && { color: tokens.colors.viridian }]}>
              {copied ? 'Address copied' : copy.copyLabel}
            </Text>
          </Pressable>
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  // Fills the fixed 430px action body; the card is the panel's single surface.
  body: { flex: 1, paddingVertical: 8, gap: 8 },
  card: {
    flex: 1,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: tokens.colors.borderMuted,
    backgroundColor: tokens.colors.ground,
    padding: 12,
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  // Design `.seg.sm`: 200 wide, hairline track, 28-tall segments.
  toggle: {
    width: 200,
    flexDirection: 'row',
    borderWidth: 1,
    borderColor: tokens.colors.borderMuted,
    borderRadius: 6,
    padding: 2,
  },
  toggleSegment: {
    flex: 1,
    height: 28,
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  toggleSegmentOn: { backgroundColor: tokens.colors.lift },
  toggleLabel: {
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 1,
    textTransform: 'uppercase',
    fontFamily: 'monospace',
    color: tokens.colors.textDim,
  },
  toggleLabelOn: { color: tokens.colors.bone },
  qrBody: { alignItems: 'center', gap: 10 },
  // Design `.qr`: light tile, dark modules, so scans resolve on any camera.
  qrTile: {
    width: 142,
    height: 142,
    padding: 8,
    borderRadius: 8,
    backgroundColor: tokens.colors.bone,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addr: {
    fontFamily: 'monospace',
    fontSize: 11,
    color: tokens.colors.bone,
  },
  // Design `.dstrip`: 52 tall, both lines dim mono 11, gap 4, padding 0 4.
  dstrip: { height: 52, justifyContent: 'center', gap: 4, paddingHorizontal: 4 },
  dstripLine: {
    fontSize: 11,
    fontFamily: 'monospace',
    color: tokens.colors.textDim,
  },
  note: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 12,
  },
  noteTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: tokens.colors.bone,
  },
  noteBody: {
    fontSize: 13,
    lineHeight: 18,
    textAlign: 'center',
    color: tokens.colors.textDim,
  },
  // Design `.copybtn`: 54 tall gold outline, radius 12 — where the slider sits.
  copy: {
    minHeight: 54,
    alignSelf: 'stretch',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: tokens.colors.accent,
  },
  copyLabel: {
    fontSize: 15,
    fontWeight: '600',
    color: tokens.colors.accent,
  },
  connect: {
    minHeight: 44,
    borderRadius: 10,
    paddingHorizontal: 28,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: tokens.colors.accent,
    marginTop: 4,
  },
  connectLabel: {
    fontSize: 14,
    fontWeight: '700',
    color: tokens.colors.walletCore,
  },
  pressed: { opacity: 0.7 },
});
