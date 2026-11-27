/**
 * App view — the "Updating {app}" banner (issue #864, design wallet.html
 * frame "9. States > App view · stale", mock `.bn` with `.spin`).
 *
 * One banner every app-view top block shares (Phoenix, Pacifica — the
 * Phoenix block reused — and Meteora): a gold spinner, the "Updating {app}"
 * title and the "Showing the last good numbers from {age} while it
 * retries." line, drawn in the #865 failure banner's place while a refresh
 * retries and the held figures stay dimmed in the top block.
 *
 * While the hook's `loading` is true the spinner turns and nothing retries
 * on its own; when it is false (the retry ended and failed, or nothing has
 * retried yet) the banner also shows the gold "Retry →" that calls the
 * hook's `retry` — the frame draws only the spinner.
 */

import { memo } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { semantic, tokens } from '@/theme';

export const AppUpdatingBanner = memo(function AppUpdatingBanner({
  name,
  ageText,
  loading,
  onRetry,
}: {
  /** App name in the title: "Updating Phoenix". */
  name: string;
  /** The held summary's age, from staleAgeText ("2 minutes ago"). */
  ageText: string;
  /** The hook's loading: true → the spinner turns, no Retry link. */
  loading: boolean;
  /** The hook's retry, called by the Retry link when loading is false. */
  onRetry: () => void;
}) {
  return (
    <View style={styles.root}>
      <ActivityIndicator
        animating={loading}
        hidesWhenStopped={false}
        size="small"
        color={tokens.colors.primaryDim}
      />
      <View style={styles.copy}>
        <Text style={styles.title}>{`Updating ${name}`}</Text>
        <Text style={styles.line}>
          {`Showing the last good numbers from ${ageText} while it retries.`}
        </Text>
      </View>
      {!loading ? (
        <Pressable
          onPress={onRetry}
          accessibilityRole="button"
          accessibilityLabel={`Retry ${name}`}
          hitSlop={8}
          style={({ pressed }) => [styles.retry, pressed && styles.pressed]}
        >
          <Text style={styles.retryLabel}>{'Retry →'}</Text>
        </Pressable>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  // Design ".bn": the failure banner's hairline box, gold spinner instead of
  // its pink icon; title on its line, the age note dim under it (.bn p b).
  root: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    backgroundColor: tokens.colors.surface,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: tokens.colors.borderMuted,
    padding: 12,
  },
  copy: { flex: 1, gap: 2 },
  title: { color: semantic.text.primary, fontSize: 14, fontWeight: '600' },
  line: { color: semantic.text.dim, fontSize: 12 },
  pressed: { opacity: 0.82 },
  retry: { paddingVertical: 2 },
  // Design ".fix": gold, 12.
  retryLabel: {
    color: tokens.colors.primaryDim,
    fontSize: 12,
    fontWeight: '600',
  },
});
