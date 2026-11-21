import { useEffect, useRef, useState } from 'react';
import { Dimensions, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { swapTheme as color } from '@/features/swap/swap.theme';
import {
  WALLET_ACTION_MODES,
  type WalletActionMode,
} from '@/features/wallet/wallet-mode';

/**
 * Wallet action mode switch — Swap | Move | Send | Receive (issue #715,
 * design wallet.html "Action panel (four modes)"): a four-column track
 * (#021B2614, radius 10) of 34px segments; the selected mode is navy with
 * gold text, the rest navy-on-gold at 69% ink.
 *
 * Swap is the only designed mode today: the placeholder modes stay disabled
 * and say "Coming soon" when tapped — an anchored tooltip with the same
 * mechanic the retired activity tiles used — instead of switching. The
 * switch is locked while a trade is pending, and a real mode change closes
 * any open keyboard.
 */

type SegmentNode = { measureInWindow: (callback: (x: number, y: number, w: number, h: number) => void) => void };

const TOOLTIP_AUTO_DISMISS_MS = 1800;
const TOOLTIP_WIDTH = 104;

export function WalletModeSwitch({
  mode,
  locked = false,
  onSelect,
}: {
  mode: WalletActionMode;
  /** A pending composer locks the switch ("locked while pending"). */
  locked?: boolean;
  onSelect: (mode: WalletActionMode) => void;
}) {
  const [tooltip, setTooltip] = useState<{ top: number; left: number } | null>(null);
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const segmentRefs = useRef<Record<WalletActionMode, SegmentNode | null>>({
    swap: null,
    move: null,
    send: null,
    receive: null,
  });
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

  function handlePress(id: WalletActionMode) {
    if (locked || id === mode) return;
    const option = WALLET_ACTION_MODES.find((candidate) => candidate.id === id);
    if (!option) return;
    if (option.enabled) {
      clearDismissTimer();
      setTooltip(null);
      onSelect(id);
      return;
    }
    const node = segmentRefs.current[id];
    if (!node) return;
    node.measureInWindow((x, y, w) => {
      // measureInWindow's callback fires asynchronously — a tap right before
      // unmount could resolve after unmount.
      if (!isMounted.current) return;
      const screenW = Dimensions.get('window').width;
      let left = x + w / 2 - TOOLTIP_WIDTH / 2;
      if (left < 8) left = 8;
      if (left + TOOLTIP_WIDTH > screenW - 8) left = screenW - TOOLTIP_WIDTH - 8;
      setTooltip({ top: y - 40, left });

      clearDismissTimer();
      dismissTimer.current = setTimeout(() => {
        if (isMounted.current) setTooltip(null);
      }, TOOLTIP_AUTO_DISMISS_MS);
    });
  }

  return (
    <View style={styles.track}>
      {WALLET_ACTION_MODES.map((option) => (
        <Pressable
          key={option.id}
          ref={(node) => { segmentRefs.current[option.id] = node; }}
          onPress={() => handlePress(option.id)}
          accessibilityRole="tab"
          accessibilityLabel={option.label}
          accessibilityState={{ selected: mode === option.id }}
          accessibilityHint={option.enabled ? 'Switch to this mode' : 'Coming soon'}
          style={[styles.segment, mode === option.id && styles.segmentOn]}
        >
          <Text style={[styles.label, mode === option.id && styles.labelOn]}>
            {option.label}
          </Text>
        </Pressable>
      ))}

      <Modal visible={tooltip !== null} transparent animationType="fade" onRequestClose={() => setTooltip(null)}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Dismiss"
          style={styles.backdrop}
          onPress={() => setTooltip(null)}
        >
          {tooltip ? (
            <View style={[styles.tooltip, { top: tooltip.top, left: tooltip.left }]}>
              <Text style={styles.tooltipText}>Coming soon</Text>
            </View>
          ) : null}
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    flexDirection: 'row',
    padding: 3,
    borderRadius: 10,
    backgroundColor: 'rgba(2,27,38,0.08)',
    marginBottom: 10,
  },
  segment: {
    flex: 1,
    height: 34,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segmentOn: { backgroundColor: color.navy },
  label: {
    fontSize: 13,
    fontWeight: '600',
    color: 'rgba(2,27,38,0.69)',
  },
  labelOn: { color: color.gold },
  backdrop: {
    flex: 1,
  },
  tooltip: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.navy,
    borderRadius: 6,
    paddingVertical: 6,
    paddingHorizontal: 10,
  },
  tooltipText: {
    fontSize: 12,
    color: color.gold,
  },
});
