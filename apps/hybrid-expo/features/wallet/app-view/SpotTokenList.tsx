/**
 * Wallet app view — Spot token list (issue #844, design wallet.html frame
 * "8. App view > Spot · token list").
 *
 * Under the shell's back control: the chain header (icon, "Solana · Spot",
 * "{n} tokens · dust hidden", the chain total), the "Tokens" label with the
 * "Swap opens Swap mode" hint, one row per token above $1 with a Swap button
 * (which calls `onSwap(mint)`, the Wallet's prefill setter from #906), and the
 * note. Loading shows skeleton rows; a failed summary with nothing to show
 * says "Nothing to show until Spot loads." (the banner and retry are #865).
 * The balance and price line from the frame is not drawn: the summary's spot
 * tokens carry only mint, symbol, icon and value.
 */

import { memo } from 'react';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { Image } from 'expo-image';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { swapTheme as color } from '@/features/swap/swap.theme';
import { useWalletSummary } from '@/features/wallet/useWalletSummary';
import { tokens as theme } from '@/theme';
import { spotTokenList } from './spot-token-list';

export const SpotTokenList = memo(function SpotTokenList({
  solana,
  evm,
  onSwap,
}: {
  solana: string | null;
  evm: string | null;
  /** The Wallet's `setSwapFromSpot` (#906): fills the pay card and selects Swap. */
  onSwap: (mint: string) => void;
}) {
  const { summary, loading } = useWalletSummary(solana, evm);
  const list = spotTokenList(summary);

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.header}>
        <View style={styles.chainIcon}>
          <MaterialIcons name="toll" size={22} color={theme.walletBrand.spot} />
        </View>
        <View style={styles.headerCopy}>
          <Text style={styles.title}>Solana · Spot</Text>
          {list ? <Text style={styles.sub}>{list.countLine}</Text> : null}
        </View>
        {list ? <Text style={styles.total}>{list.total}</Text> : null}
      </View>
      <View style={styles.labels}>
        <Text style={styles.label}>Tokens</Text>
        <Text style={styles.label}>Swap opens Swap mode</Text>
      </View>
      {list ? (
        <View style={styles.rows}>
          {list.rows.map((row) => (
            <View key={row.mint} style={styles.row}>
              <View style={styles.rowLeft}>
                {row.iconUrl ? (
                  <Image source={row.iconUrl} style={styles.icon} contentFit="cover" />
                ) : (
                  <View style={[styles.icon, styles.iconFallback]}>
                    <Text style={styles.iconLetter}>{row.symbol.slice(0, 1)}</Text>
                  </View>
                )}
                <Text numberOfLines={1} style={styles.symbol}>{row.symbol}</Text>
              </View>
              <View style={styles.rowRight}>
                <Text style={styles.value}>{row.value}</Text>
                <Pressable
                  onPress={() => onSwap(row.mint)}
                  accessibilityRole="button"
                  accessibilityLabel={`Swap ${row.symbol}`}
                  style={({ pressed }) => [styles.swap, pressed && styles.pressed]}
                >
                  <Text style={styles.swapLabel}>Swap</Text>
                </Pressable>
              </View>
            </View>
          ))}
        </View>
      ) : loading ? (
        <View style={styles.rows}>
          {[0, 1].map((key) => (
            <View key={key} style={styles.row}>
              <View style={styles.rowLeft}>
                <View style={[styles.icon, styles.skeleton]} />
                <View style={[styles.skeletonBar, styles.skeleton]} />
              </View>
              <View style={[styles.skeletonBar, styles.skeleton]} />
            </View>
          ))}
        </View>
      ) : (
        <Text style={styles.empty}>Nothing to show until Spot loads.</Text>
      )}
      <Text style={styles.note}>Swap opens Swap mode here with the token filled in.</Text>
    </ScrollView>
  );
});

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  content: { gap: 12, paddingTop: 8, paddingBottom: 40 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  chainIcon: { width: 40, height: 40, borderRadius: 20, backgroundColor: color.card, alignItems: 'center', justifyContent: 'center' },
  headerCopy: { flex: 1, minWidth: 0, gap: 2 },
  title: { color: color.text, fontSize: 18, fontWeight: '600' },
  sub: { color: color.dim, fontSize: 11 },
  total: { color: color.text, fontSize: 18, fontWeight: '600', fontVariant: ['tabular-nums'] },
  labels: { flexDirection: 'row', justifyContent: 'space-between' },
  label: { color: color.dim, fontSize: 11 },
  rows: { backgroundColor: color.card, borderRadius: 8, borderWidth: 1, borderColor: color.border },
  row: { minHeight: 56, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingHorizontal: 12, paddingVertical: 8 },
  rowLeft: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 10 },
  rowRight: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  icon: { width: 32, height: 32, borderRadius: 16 },
  iconFallback: { borderWidth: 1, borderColor: color.border, alignItems: 'center', justifyContent: 'center' },
  iconLetter: { color: color.gold, fontSize: 14, fontWeight: '700' },
  symbol: { flexShrink: 1, color: color.text, fontSize: 15, fontWeight: '700' },
  value: { color: color.text, fontSize: 14, fontWeight: '600', fontVariant: ['tabular-nums'] },
  swap: { minHeight: 32, minWidth: 56, borderRadius: 6, borderWidth: 1, borderColor: color.gold, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 10 },
  swapLabel: { color: color.gold, fontSize: 12, fontWeight: '700' },
  pressed: { opacity: 0.7 },
  skeleton: { backgroundColor: color.border },
  skeletonBar: { width: 72, height: 14, borderRadius: 4 },
  empty: { color: color.dim, fontSize: 13, textAlign: 'center', paddingVertical: 24 },
  note: { color: color.dim, fontSize: 11, textAlign: 'center' },
});
