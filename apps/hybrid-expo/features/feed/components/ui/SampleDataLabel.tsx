import { StyleSheet, Text, View } from 'react-native';
import type { ReactNode } from 'react';
import { FEED_TOKENS, monoFontFamily } from '../../feed-design';
import { FEED_MOCKS } from '../../feed-mocks';

interface SampleDataLabelProps {
  /** Defaults to the FEED_MOCKS flag from the environment. */
  enabled?: boolean;
}

const styles = StyleSheet.create({
  label: {
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderColor: FEED_TOKENS.colors.textFaint,
    borderRadius: FEED_TOKENS.radius.chip,
    color: FEED_TOKENS.colors.textFaint,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.label,
    letterSpacing: 1,
    padding: FEED_TOKENS.space.xs,
  },
  mock: {
    alignItems: 'flex-start',
    gap: FEED_TOKENS.space.xs,
  },
});

/** Small faint chip marking prototype-only content. Hidden unless mocks are on. */
export function SampleDataLabel({ enabled }: SampleDataLabelProps) {
  if (!(enabled ?? FEED_MOCKS)) {
    return null;
  }

  return <Text style={styles.label}>SAMPLE DATA</Text>;
}

interface MockOnlyProps {
  /** Defaults to the FEED_MOCKS flag from the environment. */
  enabled?: boolean;
  children?: ReactNode;
}

/** Renders sample content and its SAMPLE DATA tag only when mocks are active. */
export function MockOnly({ enabled, children }: MockOnlyProps) {
  if (!(enabled ?? FEED_MOCKS)) {
    return null;
  }

  return (
    <View style={styles.mock}>
      <SampleDataLabel enabled />
      {children}
    </View>
  );
}