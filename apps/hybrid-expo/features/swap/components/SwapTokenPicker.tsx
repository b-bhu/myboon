import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SwapTokenAvatar } from '@/features/swap/components/AssetSwap';
import { swapTheme as color } from '@/features/swap/swap.theme';
import type { SwapToken } from '@/features/swap/swap.types';

export function SwapTokenPicker({
  query,
  onQuery,
  loading,
  error,
  tokens,
  onSelect,
  onRetry,
}: {
  query: string;
  onQuery: (query: string) => void;
  loading: boolean;
  error: string | null;
  tokens: SwapToken[];
  onSelect: (token: SwapToken) => void;
  onRetry: () => void;
}) {
  return (
    <View style={styles.content}>
      <TextInput
        autoFocus
        value={query}
        onChangeText={onQuery}
        placeholder="Search token or paste mint"
        placeholderTextColor={color.dim}
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.search}
        accessibilityLabel="Search tokens by name or mint"
      />
      {loading ? (
        <View style={styles.loading}>
          <ActivityIndicator color={color.gold} />
          <Text style={styles.note}>Searching tokens…</Text>
        </View>
      ) : null}
      {error ? (
        <>
          <Text selectable accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
          <Pressable
            onPress={onRetry}
            style={styles.retry}
            accessibilityRole="button"
            accessibilityLabel="Retry token search"
          >
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </>
      ) : null}
      {!loading && !error && tokens.length === 0 ? (
        <Text style={styles.note}>No tokens found. Try a name or mint address.</Text>
      ) : null}
      {!error && !loading
        ? tokens.map((token) => (
            <Pressable
              key={token.address}
              onPress={() => onSelect(token)}
              style={styles.token}
              accessibilityRole="button"
              accessibilityLabel={`${token.symbol}, ${token.name}, mint ${token.address}`}
            >
              <SwapTokenAvatar token={token} />
              <View style={styles.identity}>
                <Text style={styles.symbol}>{token.symbol}</Text>
                <Text style={styles.note}>{token.name}</Text>
              </View>
              <Text style={styles.mint}>
                {token.address.slice(0, 4)}…{token.address.slice(-4)}
              </Text>
            </Pressable>
          ))
        : null}
    </View>
  );
}

const styles = StyleSheet.create({
  content: { gap: 10 },
  search: {
    minHeight: 48,
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: color.border,
    backgroundColor: color.card,
    color: color.text,
    fontSize: 14,
  },
  loading: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 12 },
  note: { color: color.dim, fontSize: 13, lineHeight: 18 },
  error: { color: color.error, fontSize: 14, lineHeight: 20 },
  retry: {
    minHeight: 44,
    borderRadius: 8,
    backgroundColor: color.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  retryText: { color: color.gold, fontSize: 14 },
  token: {
    minHeight: 60,
    gap: 10,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderColor: color.border,
    paddingVertical: 8,
  },
  identity: { flex: 1, minWidth: 0 },
  symbol: { color: color.text, fontSize: 15, fontWeight: '700' },
  mint: { color: color.dim, fontSize: 11 },
});
