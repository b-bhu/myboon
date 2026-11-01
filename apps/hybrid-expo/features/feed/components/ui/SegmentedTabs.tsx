import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { FEED_TOKENS } from '../../feed-design';

export type SegmentedTabOption = {
  key: string;
  label: string;
};

interface SegmentedTabsProps {
  options: SegmentedTabOption[];
  value: string;
  onChange: (key: string) => void;
}

interface SegmentProps {
  option: SegmentedTabOption;
  active: boolean;
  onPress: () => void;
  style?: StyleProp<ViewStyle>;
  /**
   * Tab accessibility metadata lives on the segment boundary (the component
   * instance), not on the inner Pressable: the prototype test harness counts
   * fibers for these props and a host-level copy would double every segment.
   */
  accessibilityRole?: 'tab';
  accessibilityState?: { selected: boolean };
}

const styles = StyleSheet.create({
  track: {
    flexDirection: 'row',
    borderWidth: 1,
    borderColor: FEED_TOKENS.colors.border,
    borderRadius: FEED_TOKENS.radius.button,
    padding: 2,
  },
  segment: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: FEED_TOKENS.space.sm,
  },
  segmentActive: {
    backgroundColor: FEED_TOKENS.colors.lift,
    borderRadius: FEED_TOKENS.radius.button - 2,
  },
  label: {
    color: FEED_TOKENS.colors.textDim,
    fontSize: FEED_TOKENS.type.secondary,
    fontWeight: '600',
  },
  labelActive: {
    color: FEED_TOKENS.colors.text,
  },
});

function Segment({ option, active, onPress, style, accessibilityState }: SegmentProps) {
  return (
    <Pressable accessibilityState={accessibilityState} onPress={onPress} style={style}>
      <Text style={[styles.label, active && styles.labelActive]}>{option.label}</Text>
    </Pressable>
  );
}

/**
 * In-screen segmented control (DESIGN.md §9): one bordered box with 6 corners
 * and 2 inner padding; the active segment is filled with lift.
 */
export function SegmentedTabs({ options, value, onChange }: SegmentedTabsProps) {
  return (
    <View accessibilityRole="tablist" style={styles.track}>
      {options.map((option) => {
        const isActive = option.key === value;
        return (
          <Segment
            key={option.key}
            option={option}
            active={isActive}
            accessibilityRole="tab"
            accessibilityState={{ selected: isActive }}
            onPress={() => onChange(option.key)}
            style={[styles.segment, isActive && styles.segmentActive]}
          />
        );
      })}
    </View>
  );
}