import { useEffect, useRef, useState } from 'react';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { Dimensions, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { semantic, tokens } from '@/theme';

/**
 * Wallet activity tiles — Send, Receive, Transfer (issue #241, PRD design
 * decision #18, PRD decision #9).
 *
 * These three are the only wallet-activity tiles designed and shipped in P0
 * (Deposit/Withdraw are explicitly out of scope — never designed in
 * wallet_mock.html, tracked as a future follow-up, per issue #241 and
 * TC-ACT-003). Tiles render fully-styled and tappable — no "Soon" badge, no
 * muted/disabled treatment, no lock icon (TC-ACT-001) — and tapping one shows
 * a small "Coming soon" tooltip anchored to that tile (TC-ACT-002), dismissed
 * by tapping anywhere else on screen or after a ~1.8s auto-timeout.
 */

type ActivityId = 'send' | 'receive' | 'transfer' | 'swap';

const ACTIVITIES: { id: ActivityId; label: string; icon: 'arrow-upward' | 'arrow-downward' | 'swap-horiz' | 'currency-exchange' }[] = [
  { id: 'swap', label: 'Swap', icon: 'currency-exchange' },
  { id: 'send', label: 'Send', icon: 'arrow-upward' },
  { id: 'receive', label: 'Receive', icon: 'arrow-downward' },
  { id: 'transfer', label: 'Transfer', icon: 'swap-horiz' },
];

const TOOLTIP_AUTO_DISMISS_MS = 1800;
const TOOLTIP_WIDTH = 104;

export function WalletActivityTiles({ onSwap }: { onSwap?: () => void }) {
  const [tooltip, setTooltip] = useState<{ x: number; y: number; w: number } | null>(null);
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tileRefs = useRef<Record<ActivityId, View | null>>({ send: null, receive: null, transfer: null, swap: null });
  const isMounted = useRef(true);

  useEffect(() => () => {
    isMounted.current = false;
    if (dismissTimer.current) clearTimeout(dismissTimer.current);
  }, []);

  function clearDismissTimer() {
    if (dismissTimer.current) {
      clearTimeout(dismissTimer.current);
      dismissTimer.current = null;
    }
  }

  function handleTilePress(id: ActivityId) {
    const node = tileRefs.current[id];
    if (!node) return;
    node.measureInWindow((x, y, w) => {
      // measureInWindow's callback fires asynchronously — a tap right before
      // navigating away could resolve after unmount.
      if (!isMounted.current) return;
      const screenW = Dimensions.get('window').width;
      let left = x + w / 2 - TOOLTIP_WIDTH / 2;
      if (left < 8) left = 8;
      if (left + TOOLTIP_WIDTH > screenW - 8) left = screenW - TOOLTIP_WIDTH - 8;
      setTooltip({ x: left, y, w: TOOLTIP_WIDTH });

      clearDismissTimer();
      dismissTimer.current = setTimeout(() => {
        if (isMounted.current) setTooltip(null);
      }, TOOLTIP_AUTO_DISMISS_MS);
    });
  }

  function handleDismiss() {
    clearDismissTimer();
    setTooltip(null);
  }

  return (
    <View style={styles.row}>
      {ACTIVITIES.map((activity) => (
        <Pressable
          key={activity.id}
          ref={(node) => { tileRefs.current[activity.id] = node; }}
          onPress={() => activity.id === 'swap' && onSwap ? onSwap() : handleTilePress(activity.id)}
          accessibilityRole="button"
          accessibilityLabel={activity.label}
          accessibilityHint={activity.id === 'swap' ? 'Open Swap' : 'Coming soon'}
          style={({ pressed }) => [styles.tile, pressed && styles.tilePressed]}
        >
          <MaterialIcons name={activity.icon} size={15} color={semantic.text.dim} />
          <Text style={styles.tileText}>{activity.label}</Text>
        </Pressable>
      ))}

      <Modal visible={tooltip !== null} transparent animationType="fade" onRequestClose={handleDismiss}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Dismiss tooltip"
          style={styles.backdrop}
          onPress={handleDismiss}
        >
          {tooltip ? (
            <View style={[styles.tooltip, { top: tooltip.y - 40, left: tooltip.x, width: tooltip.w }]}>
              <Text style={styles.tooltipText}>Coming soon</Text>
            </View>
          ) : null}
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: tokens.spacing.sm,
  },
  tile: {
    flex: 1,
    minHeight: 52,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    borderRadius: 8,
    backgroundColor: 'rgba(6,51,67,0.78)',
    borderWidth: 1,
    borderColor: 'rgba(24,90,112,0.78)',
  },
  tilePressed: {
    backgroundColor: 'rgba(10,74,96,0.6)',
    borderColor: 'rgba(24,90,112,0.95)',
  },
  tileText: {
    fontFamily: 'monospace',
    fontSize: 8,
    fontWeight: '900',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: semantic.text.dim,
  },
  backdrop: {
    flex: 1,
  },
  tooltip: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: semantic.background.screen,
    borderWidth: 1,
    borderColor: 'rgba(24,90,112,0.78)',
    borderRadius: 6,
    paddingVertical: 6,
    paddingHorizontal: 10,
  },
  tooltipText: {
    fontFamily: 'monospace',
    fontSize: 8.5,
    color: semantic.text.primary,
  },
});
