/**
 * DESIGN.md §9 in-segment tabs: one bordered box (6 corners, 2 inner padding),
 * active segment filled with `lift`, text `bone`; inactive text `dim`.
 * No underline tabs and no chip tabs.
 */

import { Pressable, StyleSheet, Text, View } from 'react-native';
import { tokens } from '@/theme/tokens';

export interface SegmentedOption<K extends string = string> {
  key: K;
  label: string;
}

export function Segmented({
  options,
  value,
  onChange,
  disabled = false,
  testID,
  accessibilityLabel,
}: {
  options: readonly SegmentedOption[];
  value: string;
  onChange: (key: string) => void;
  disabled?: boolean;
  testID?: string;
  accessibilityLabel?: string;
}) {
  return (
    <View
      style={[styles.box, disabled && styles.disabled]}
      testID={testID}
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="tablist"
    >
      {options.map((option) => {
        const active = option.key === value;
        return (
          <Pressable
            key={option.key}
            disabled={disabled}
            onPress={() => onChange(option.key)}
            style={[styles.seg, active && styles.segActive]}
            accessibilityRole="tab"
            accessibilityState={{ selected: active, disabled }}
          >
            <Text style={[styles.text, active && styles.textActive]}>{option.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    flexDirection: 'row',
    borderWidth: 1,
    borderColor: tokens.colors.borderMuted,
    borderRadius: 6,
    padding: 2,
  },
  disabled: { opacity: 0.5 },
  seg: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 7,
    paddingHorizontal: 8,
    borderRadius: 4,
  },
  segActive: { backgroundColor: tokens.colors.lift },
  text: {
    fontSize: 12,
    lineHeight: 15,
    color: tokens.colors.textDim,
    letterSpacing: tokens.letterSpacing.tighter,
  },
  textActive: { color: tokens.colors.bone },
});
