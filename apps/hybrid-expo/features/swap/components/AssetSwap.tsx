import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { Image } from 'expo-image';
import type { RefObject } from 'react';
import { Keyboard, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { formatAtomicAmount } from '@/features/swap/swap.math';
import { swapTheme as color } from '@/features/swap/swap.theme';
import type { SwapSide, SwapToken } from '@/features/swap/swap.types';

export function SwapTokenAvatar({ token }: { token: SwapToken }) {
  return token.logoURI ? (
    <Image source={token.logoURI} style={styles.avatar} contentFit="cover" />
  ) : (
    <View style={[styles.avatar, styles.avatarFallback]}>
      <Text style={styles.avatarLetter}>{token.symbol.slice(0, 1)}</Text>
    </View>
  );
}

function fiat(value: number | null) {
  return value === null || !Number.isFinite(value)
    ? 'Unavailable'
    : value.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

/** Controlled presentation: order preparation, signing and submission belong to the controller. */
export function AssetSwap({
  inputToken,
  outputToken,
  amount,
  outputAmount,
  inputUsd,
  outputUsd,
  inputBalance,
  busy,
  onAmount,
  onPicker,
  onReverse,
  onBalanceShortcuts,
  payInputRef,
  reviewLabel,
  reviewEnabled,
  reviewLoading,
  onReview,
}: {
  inputToken: SwapToken;
  outputToken: SwapToken;
  amount: string;
  outputAmount: string;
  inputUsd: number | null;
  outputUsd: number | null;
  inputBalance?: string;
  busy: boolean;
  onAmount: (amount: string) => void;
  onPicker: (side: SwapSide) => void;
  onReverse: () => void;
  onBalanceShortcuts: () => void;
  payInputRef: RefObject<TextInput | null>;
  reviewLabel: string;
  reviewEnabled: boolean;
  reviewLoading: boolean;
  onReview: () => void;
}) {
  const renderAsset = (side: SwapSide, token: SwapToken, value: string, usd: number | null) => (
    <View style={styles.assetRow}>
      <View style={styles.identity}>
        <Text style={styles.label}>{side === 'input' ? 'You pay' : 'You receive'}</Text>
        <Pressable
          onPress={() => onPicker(side)}
          disabled={busy}
          style={styles.picker}
          accessibilityRole="button"
          accessibilityLabel={`Choose ${side === 'input' ? 'Pay' : 'Receive'} asset, ${token.symbol}`}
          accessibilityState={{ disabled: busy }}
        >
          <SwapTokenAvatar token={token} />
          <Text style={styles.symbol} numberOfLines={1}>
            {token.symbol}
          </Text>
          <MaterialIcons name="expand-more" size={18} color={color.dim} />
        </Pressable>
      </View>
      <View style={styles.amountColumn}>
        {side === 'input' ? (
          <TextInput
            ref={payInputRef}
            value={amount}
            onChangeText={(next) => onAmount(next.replace(/[^\d.]/g, ''))}
            editable={!busy}
            keyboardType="decimal-pad"
            returnKeyType="done"
            onSubmitEditing={Keyboard.dismiss}
            placeholder="0"
            placeholderTextColor={color.dim}
            style={styles.amount}
            accessibilityLabel="You pay amount"
          />
        ) : (
          <Text
            selectable
            style={styles.output}
            numberOfLines={1}
            adjustsFontSizeToFit
            minimumFontScale={0.65}
            accessibilityLabel={`You receive ${value} ${token.symbol}`}
          >
            {value}
          </Text>
        )}
        <Text selectable style={styles.fiat}>
          {value === '' || value === '—' ? '—' : fiat(usd)}
        </Text>
      </View>
    </View>
  );
  return (
    <View style={styles.card}>
      {renderAsset('input', inputToken, amount, inputUsd)}
      <View style={styles.seam}>
        <View style={styles.line} />
        <Pressable
          disabled={busy}
          onPress={onReverse}
          style={styles.reverse}
          accessibilityRole="button"
          accessibilityLabel="Reverse pair"
          accessibilityHint="Tap once to reverse. Tap twice to open wallet actions."
          accessibilityState={{ disabled: busy }}
        >
          <MaterialIcons name="swap-vert" size={21} color={color.navy} />
        </Pressable>
      </View>
      {renderAsset('output', outputToken, outputAmount, outputUsd)}
      <View style={styles.bottomRow}>
        <Pressable
          disabled={busy || inputBalance === undefined}
          onPress={onBalanceShortcuts}
          style={styles.balance}
          accessibilityRole="button"
          accessibilityLabel={`Pay balance ${inputBalance === undefined ? 'unavailable' : formatAtomicAmount(inputBalance, inputToken.decimals, 6)} ${inputToken.symbol}. Open balance shortcuts.`}
          accessibilityState={{ disabled: busy || inputBalance === undefined }}
        >
          <Text style={styles.balanceText}>
            Balance{' '}
            {inputBalance === undefined
              ? '—'
              : formatAtomicAmount(inputBalance, inputToken.decimals, 6)}{' '}
            {inputToken.symbol}
          </Text>
          <MaterialIcons name="expand-more" size={14} color={color.dim} />
        </Pressable>
      </View>
      <Pressable
        onPress={onReview}
        disabled={!reviewEnabled || reviewLoading}
        style={[styles.review, (!reviewEnabled || reviewLoading) && styles.disabled]}
        accessibilityRole="button"
        accessibilityLabel={reviewLabel}
        accessibilityState={{ disabled: !reviewEnabled || reviewLoading, busy: reviewLoading }}
      >
        <Text style={[styles.reviewText, (!reviewEnabled || reviewLoading) && styles.disabledText]}>
          {reviewLabel}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: color.navy, padding: 12, borderRadius: color.composerRadius, gap: 3 },
  assetRow: { minHeight: 66, flexDirection: 'row', alignItems: 'center', gap: 8 },
  identity: { flex: 1, minWidth: 110, maxWidth: '50%' },
  label: { fontSize: 12, lineHeight: 16, color: color.dim, fontWeight: '600' },
  picker: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 6 },
  avatar: { width: 25, height: 25, borderRadius: 13, backgroundColor: color.card },
  avatarFallback: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: color.border,
  },
  avatarLetter: { color: color.gold, fontSize: 14, fontWeight: '700' },
  symbol: { flexShrink: 1, color: color.text, fontSize: 17, fontWeight: '700' },
  amountColumn: { flex: 1, minWidth: 0, alignItems: 'flex-end' },
  amount: {
    minHeight: 44,
    width: '100%',
    color: color.text,
    fontSize: 30,
    fontWeight: '600',
    textAlign: 'right',
    padding: 0,
    fontVariant: ['tabular-nums'],
  },
  output: {
    minHeight: 40,
    width: '100%',
    color: color.text,
    fontSize: 30,
    fontWeight: '600',
    textAlign: 'right',
    fontVariant: ['tabular-nums'],
  },
  fiat: { color: color.dim, fontSize: 11, fontVariant: ['tabular-nums'] },
  seam: { height: 12, alignItems: 'center', justifyContent: 'center', zIndex: 1 },
  line: { height: 1, width: '100%', backgroundColor: color.border },
  reverse: {
    position: 'absolute',
    minWidth: 44,
    minHeight: 44,
    borderRadius: 22,
    borderWidth: 5,
    borderColor: color.navy,
    backgroundColor: color.gold,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bottomRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end' },
  balance: {
    minHeight: 44,
    paddingHorizontal: 4,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  balanceText: { color: color.dim, fontSize: 11, flexShrink: 1, fontVariant: ['tabular-nums'] },
  review: {
    minHeight: 44,
    borderRadius: 10,
    padding: 10,
    backgroundColor: color.gold,
    alignItems: 'center',
    justifyContent: 'center',
  },
  reviewText: { color: color.navy, fontSize: 14, fontWeight: '700', textAlign: 'center' },
  disabled: { backgroundColor: color.card },
  disabledText: { color: color.dim },
});
