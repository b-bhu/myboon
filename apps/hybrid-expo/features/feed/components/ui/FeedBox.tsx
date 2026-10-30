import { Pressable, StyleSheet, View } from 'react-native';
import type { ReactNode } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import { FEED_TOKENS } from '../../feed-design';
import type { FeedBoxTone } from '../../feed-design';

export type { FeedBoxTone };

interface FeedBoxProps {
  /** Background fill of the boxed card. Defaults to ground. */
  tone?: FeedBoxTone;
  /** When set the whole box is tappable. */
  onPress?: () => void;
  /**
   * Test/automation id for the FeedBox boundary. Kept on the component
   * instance and not forwarded onto child views (the prototype test harness
   * counts matching fibers).
   */
  testID?: string;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
}

const styles = StyleSheet.create({
  box: {
    borderWidth: 1,
    borderColor: FEED_TOKENS.colors.border,
    borderRadius: FEED_TOKENS.radius.card,
    padding: FEED_TOKENS.space.md,
  },
});

/** Boxed Feed card: 1px hairline, 8 corners, 12 padding (DESIGN.md §4/§7). */
export function FeedBox({
  tone = 'ground',
  onPress,
  testID,
  accessibilityLabel,
  style,
  children,
}: FeedBoxProps) {
  const boxStyle: StyleProp<ViewStyle> = [
    styles.box,
    { backgroundColor: FEED_TOKENS.colors[tone] },
    style,
  ];

  if (!onPress) {
    return <View style={boxStyle}>{children}</View>;
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      style={boxStyle}
    >
      {children}
    </Pressable>
  );
}