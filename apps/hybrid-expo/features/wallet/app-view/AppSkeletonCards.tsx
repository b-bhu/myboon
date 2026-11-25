/**
 * Wallet app view — the shared tab-body loading skeleton (issue #859, design
 * wallet.html frame "9. States > App view loading", component `skCards` /
 * `.skcard`; the frame draws it on Polymarket, but the card skeleton is the
 * same for every app).
 *
 * `AppSkeletonCards({ count = 3 })`: `count` skeleton cards, four static
 * bars each — `.sk` bars on `semantic.background.lift`, no spinner, no pulse
 * (the top-block skeleton is static too). Phoenix Positions (Phoenix and
 * Pacifica), Meteora Positions and Phoenix Orders show it while their list
 * is loading with none held; a retry or refresh runs while cards are held
 * and never shows this.
 */

import { memo } from 'react';
import { StyleSheet, View } from 'react-native';

import { semantic, tokens } from '@/theme';

export const AppSkeletonCards = memo(function AppSkeletonCards({ count = 3 }: { count?: number }) {
  return (
    <View style={styles.root}>
      {Array.from({ length: count }, (_, index) => (
        <View key={index} style={styles.card}>
          <View style={styles.barTitle} />
          <View style={styles.barTag} />
          <View style={styles.barLine} />
          <View style={styles.barAction} />
        </View>
      ))}
    </View>
  );
});

const styles = StyleSheet.create({
  root: { gap: 12 },
  // Mock ".skcard": surface card, hairline edge, radius 8, pad 12, gap 8,
  // 12 between cards.
  card: {
    gap: 8,
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: tokens.colors.borderMuted,
    backgroundColor: tokens.colors.surface,
  },
  // Mock ".sk": static lift bars, radius 4; the last is the action block
  // (radius 6, 4 top gap).
  barTitle: { width: '60%', height: 14, borderRadius: 4, backgroundColor: semantic.background.lift },
  barTag: { width: '35%', height: 10, borderRadius: 4, backgroundColor: semantic.background.lift },
  barLine: { width: '100%', height: 10, borderRadius: 4, backgroundColor: semantic.background.lift },
  barAction: {
    width: '30%',
    height: 32,
    marginTop: 4,
    borderRadius: 6,
    backgroundColor: semantic.background.lift,
  },
});
