import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { Image } from 'expo-image';
import type { ReactNode, RefObject } from 'react';
import { useState } from 'react';
import { Animated, Keyboard, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { formatBalance } from '@/features/swap/swap.display';
import { useSwapValueAnimation } from '@/features/swap/swap.motion';
import { swapTheme as color } from '@/features/swap/swap.theme';
import type { SwapSide, SwapToken } from '@/features/swap/swap.types';

export function SwapTokenAvatar({ token, size = 25 }: { token: SwapToken; size?: number }) {
  const avatarStyle = { width: size, height: size, borderRadius: size / 2 };
  return token.logoURI ? (
    <Image source={token.logoURI} style={[styles.avatar, avatarStyle]} contentFit="cover" />
  ) : (
    <View style={[styles.avatar, styles.avatarFallback, avatarStyle]}>
      <Text style={[styles.avatarLetter, { fontSize: Math.max(8, size * 0.55) }]}>{token.symbol.slice(0, 1)}</Text>
    </View>
  );
}

function fiat(value: number | null) {
  return value === null || !Number.isFinite(value)
    ? 'Unavailable'
    : value.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function BalanceShortcuts({
  available,
  busy,
  expanded,
  onExpand,
  onClose,
  onBalancePercent,
  symbol,
}: {
  available: boolean;
  busy: boolean;
  expanded: boolean;
  onExpand: () => void;
  onClose: () => void;
  onBalancePercent: (percent: number) => void;
  symbol: string;
}) {
  const disabled = busy || !available;
  const choose = (percent: number) => {
    onBalancePercent(percent);
    onClose();
  };
  return (
    <View style={styles.shortcutGroup} accessibilityLabel={`${symbol} balance shortcuts`}>
      <Pressable
        disabled={disabled}
        onPress={() => choose(100)}
        style={styles.shortcutButtonMax}
        accessibilityRole="button"
        accessibilityLabel={`Use maximum available ${symbol} balance`}
        accessibilityState={{ disabled }}
      >
        <Text style={styles.shortcutText}>Max</Text>
      </Pressable>
      <Text style={styles.shortcutSeparator} accessibilityElementsHidden>
        ·
      </Text>
      {!expanded ? (
        <Pressable
          disabled={disabled}
          onPress={onExpand}
          style={styles.shortcutButtonPercent}
          accessibilityRole="button"
          accessibilityLabel="Show percentage shortcuts"
          accessibilityState={{ disabled, expanded: false }}
        >
          <Text style={styles.shortcutText}>%</Text>
        </Pressable>
      ) : (
        <>
          <Pressable
            disabled={disabled}
            onPress={() => choose(50)}
            style={styles.shortcutButtonValue}
            accessibilityRole="button"
            accessibilityLabel={`Use 50 percent of available ${symbol} balance`}
            accessibilityState={{ disabled }}
          >
            <Text style={styles.shortcutText}>50%</Text>
          </Pressable>
          <Text style={styles.shortcutSeparator} accessibilityElementsHidden>
            ·
          </Text>
          <Pressable
            disabled={disabled}
            onPress={() => choose(25)}
            style={styles.shortcutButtonValue}
            accessibilityRole="button"
            accessibilityLabel={`Use 25 percent of available ${symbol} balance`}
            accessibilityState={{ disabled }}
          >
            <Text style={styles.shortcutText}>25%</Text>
          </Pressable>
          <Pressable
            disabled={disabled}
            onPress={onClose}
            style={styles.shortcutClose}
            accessibilityRole="button"
            accessibilityLabel="Close percentage shortcuts"
            accessibilityState={{ disabled }}
          >
            <MaterialIcons name="close" size={16} color={color.dim} />
          </Pressable>
        </>
      )}
    </View>
  );
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
  outputBalance,
  busy,
  onAmount,
  onAmountFocus,
  onAmountBlur,
  onPicker,
  onReverse,
  onBalancePercent,
  payInputRef,
  inputLocked = false,
  outputLocked = false,
  canReverse = true,
  children,
}: {
  inputToken: SwapToken;
  outputToken: SwapToken;
  amount: string;
  outputAmount: string;
  inputUsd: number | null;
  outputUsd: number | null;
  inputBalance?: string;
  outputBalance?: string;
  busy: boolean;
  onAmount: (amount: string) => void;
  onAmountFocus: () => void;
  onAmountBlur: () => void;
  onPicker: (side: SwapSide) => void;
  onReverse: () => void;
  onBalancePercent: (percent: number) => void;
  payInputRef: RefObject<TextInput | null>;
  inputLocked?: boolean;
  outputLocked?: boolean;
  canReverse?: boolean;
  children?: ReactNode;
}) {
  const [percentExpanded, setPercentExpanded] = useState(false);
  const payMotion = useSwapValueAnimation(amount);
  const receiveMotion = useSwapValueAnimation(outputAmount);

  const renderAsset = (
    side: SwapSide,
    token: SwapToken,
    value: string,
    usd: number | null,
    balance: string | undefined,
    locked: boolean,
  ) => (
    <View style={styles.assetBlock}>
      <View style={styles.assetRow}>
        <View style={styles.identity}>
          <Text style={styles.label}>{side === 'input' ? 'You pay' : 'You receive'}</Text>
          <Pressable
            onPress={() => onPicker(side)}
            disabled={busy || locked}
            style={[styles.picker, locked && styles.pickerLocked]}
            accessibilityRole="button"
            accessibilityLabel={`Choose ${side === 'input' ? 'Pay' : 'Receive'} asset, ${token.symbol}`}
            accessibilityState={{ disabled: busy || locked }}
          >
            <SwapTokenAvatar token={token} />
            <Text style={styles.symbol} numberOfLines={1}>
              {token.symbol}
            </Text>
            {!locked ? <MaterialIcons name="expand-more" size={18} color={color.dim} /> : null}
          </Pressable>
        </View>
        <Animated.View style={[styles.amountColumn, side === 'input' ? payMotion : receiveMotion]}>
          {side === 'input' ? (
            <TextInput
              ref={payInputRef}
              value={amount}
              onChangeText={(next) => onAmount(next.replace(/[^\d.]/g, ''))}
              editable={!busy}
              keyboardType="decimal-pad"
              returnKeyType="done"
              onFocus={onAmountFocus}
              onBlur={onAmountBlur}
              onSubmitEditing={() => { onAmountBlur(); Keyboard.dismiss(); }}
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
        </Animated.View>
      </View>
      <View style={[styles.balanceRow, side === 'output' && styles.receiveBalanceRow]}>
        <Text
          selectable
          numberOfLines={1}
          adjustsFontSizeToFit
          minimumFontScale={0.65}
          style={styles.balanceText}
          accessibilityLabel={`${side === 'input' ? 'Pay' : 'Receive'} balance ${formatBalance(balance, token.decimals)} ${token.symbol}`}
        >
          {formatBalance(balance, token.decimals)}
        </Text>
        {side === 'input' ? (
          <BalanceShortcuts
            available={balance !== undefined}
            busy={busy}
            expanded={percentExpanded}
            onExpand={() => setPercentExpanded(true)}
            onClose={() => setPercentExpanded(false)}
            onBalancePercent={onBalancePercent}
            symbol={token.symbol}
          />
        ) : null}
      </View>
    </View>
  );

  return (
    <View style={styles.card}>
      {renderAsset('input', inputToken, amount, inputUsd, inputBalance, inputLocked)}
      <View style={styles.seam}>
        <View style={styles.line} />
        <Pressable
          disabled={busy || !canReverse}
          onPress={onReverse}
          style={[styles.reverse, (!canReverse || busy) && styles.reverseDisabled]}
          accessibilityRole="button"
          accessibilityLabel="Reverse pair"
          accessibilityHint="Reverses the selected swap pair"
          accessibilityState={{ disabled: busy || !canReverse }}
        >
          <MaterialIcons name="swap-vert" size={21} color={color.navy} />
        </Pressable>
      </View>
      {renderAsset('output', outputToken, outputAmount, outputUsd, outputBalance, outputLocked)}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: color.navy, padding: 12, borderRadius: color.composerRadius, gap: 3 },
  assetBlock: { minWidth: 0 },
  assetRow: { minHeight: 60, flexDirection: 'row', alignItems: 'center', gap: 8 },
  identity: { flex: 1, minWidth: 110, maxWidth: '50%' },
  label: { fontSize: 12, lineHeight: 16, color: color.dim, fontWeight: '600' },
  picker: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 6 },
  pickerLocked: { opacity: 0.82 },
  avatar: { backgroundColor: color.card },
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
  balanceRow: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 0 },
  receiveBalanceRow: { minHeight: 20 },
  balanceText: {
    flexShrink: 1,
    color: color.dim,
    fontSize: 11,
    fontVariant: ['tabular-nums'],
  },
  shortcutGroup: { flexShrink: 0, flexDirection: 'row', alignItems: 'center' },
  shortcutButtonMax: {
    minWidth: 44,
    minHeight: 44,
    paddingHorizontal: 3,
    paddingRight: 6,
    alignItems: 'flex-end',
    justifyContent: 'center',
    borderRadius: 5,
  },
  shortcutButtonPercent: {
    minWidth: 44,
    minHeight: 44,
    paddingHorizontal: 3,
    paddingLeft: 8,
    alignItems: 'flex-start',
    justifyContent: 'center',
    borderRadius: 5,
  },
  shortcutButtonValue: {
    minWidth: 44,
    minHeight: 44,
    paddingHorizontal: 3,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 5,
  },
  shortcutClose: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 5,
  },
  shortcutText: { color: color.gold, fontSize: 11, fontWeight: '600' },
  shortcutSeparator: { width: 6, color: color.border, fontSize: 12, textAlign: 'center' },
  seam: { height: 44, marginVertical: -6, alignItems: 'center', justifyContent: 'center', zIndex: 1 },
  line: { height: 1, width: '100%', backgroundColor: color.border },
  reverse: {
    position: 'absolute',
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 4,
    borderColor: color.navy,
    backgroundColor: color.gold,
    alignItems: 'center',
    justifyContent: 'center',
  },
  reverseDisabled: { opacity: 0.6 },
});
