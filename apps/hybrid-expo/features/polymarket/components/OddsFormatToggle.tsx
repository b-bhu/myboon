import { useRef, useState } from 'react';
import { Dimensions, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import type { OddsFormat } from '@/hooks/useOddsFormat';
import { semantic, tokens } from '@/theme';

interface OddsFormatToggleProps {
  format: OddsFormat;
  onFormatChange: (f: OddsFormat) => void;
}

const OPTIONS: { value: OddsFormat; label: string; short: string }[] = [
  { value: 'probability', label: 'Probability (%)', short: '%' },
  { value: 'decimal', label: 'Decimal (2.13)', short: 'Dec' },
];

export function OddsFormatToggle({ format, onFormatChange }: OddsFormatToggleProps) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState({ x: 0, y: 0, w: 0 });
  const triggerRef = useRef<View>(null);

  const current = OPTIONS.find((o) => o.value === format) ?? OPTIONS[0];

  function handleOpen() {
    triggerRef.current?.measureInWindow((x, y, w, h) => {
      const DROPDOWN_W = 160;
      const screenW = Dimensions.get('window').width;
      // Right-align to the trigger, but clamp so it stays on screen
      let left = x + w - DROPDOWN_W;
      if (left < 8) left = 8;
      if (left + DROPDOWN_W > screenW - 8) left = screenW - DROPDOWN_W - 8;
      setAnchor({ x: left, y: y + h + 4, w: DROPDOWN_W });
      setOpen(true);
    });
  }

  function handleSelect(value: OddsFormat) {
    onFormatChange(value);
    setOpen(false);
  }

  return (
    <>
      <Pressable
        ref={triggerRef}
        accessibilityRole="button"
        accessibilityLabel={`Odds format, ${current.label}`}
        accessibilityState={{ expanded: open }}
        accessibilityHint="Choose how odds are displayed"
        onPress={handleOpen}
        style={styles.trigger}>
        <Text style={styles.triggerText}>{current.short}</Text>
        <Text style={styles.chevron}>{'\u25BE'}</Text>
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close odds format menu"
          style={styles.backdrop}
          onPress={() => setOpen(false)}>
          <View
            accessibilityRole="menu"
            accessibilityViewIsModal
            style={[styles.dropdown, { top: anchor.y, left: anchor.x, width: anchor.w }]}>
            {OPTIONS.map((opt) => {
              const isActive = opt.value === format;
              return (
                <Pressable
                  key={opt.value}
                  accessibilityRole="menuitem"
                  accessibilityLabel={opt.label}
                  accessibilityState={{ selected: isActive }}
                  onPress={() => handleSelect(opt.value)}
                  style={[styles.option, isActive && styles.optionActive]}>
                  <Text style={[styles.optionText, isActive && styles.optionTextActive]}>
                    {opt.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  trigger: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: semantic.background.surfaceRaised,
    borderWidth: 1,
    borderColor: semantic.border.muted,
    borderRadius: tokens.radius.xs,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  triggerText: {
    color: semantic.text.dim,
    fontSize: tokens.fontSize.xxs,
    fontFamily: 'monospace',
    fontWeight: '600',
    letterSpacing: 0.6,
  },
  chevron: {
    color: semantic.text.faint,
    fontSize: 8,
    marginTop: 1,
  },
  backdrop: {
    flex: 1,
  },
  dropdown: {
    position: 'absolute',
    backgroundColor: semantic.background.surfaceRaised,
    borderWidth: 1,
    borderColor: semantic.border.muted,
    borderRadius: tokens.radius.sm,
    paddingVertical: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 12,
    elevation: 8,
  },
  option: {
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  optionActive: {
    backgroundColor: 'rgba(199,183,112,0.10)',
  },
  optionText: {
    color: semantic.text.dim,
    fontSize: 11,
    fontFamily: 'monospace',
    letterSpacing: 0.3,
  },
  optionTextActive: {
    color: semantic.text.accent,
    fontWeight: '700',
  },
});
