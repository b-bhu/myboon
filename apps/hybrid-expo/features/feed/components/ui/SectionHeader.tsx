import { StyleSheet, Text, View } from 'react-native';
import { FEED_TOKENS, monoFontFamily } from '../../feed-design';

interface SectionHeaderProps {
  title: string;
  /** Optional accent link on the right, e.g. "All updates →". */
  linkLabel?: string;
  onLinkPress?: () => void;
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: FEED_TOKENS.space.md,
  },
  title: {
    flex: 1,
    color: FEED_TOKENS.colors.text,
    fontSize: FEED_TOKENS.type.section,
    fontWeight: '700',
  },
  link: {
    color: FEED_TOKENS.colors.accent,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.label,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
});

/** Section header: 20/700 title with an optional gold link on the right. */
export function SectionHeader({ title, linkLabel, onLinkPress }: SectionHeaderProps) {
  const showLink = Boolean(linkLabel && onLinkPress);

  return (
    <View style={styles.row}>
      <Text style={styles.title}>{title}</Text>
      {showLink ? (
        <Text accessibilityRole="link" onPress={onLinkPress} style={styles.link}>
          {linkLabel}
        </Text>
      ) : null}
    </View>
  );
}