import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { Image } from 'expo-image';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useIsFocused } from '@react-navigation/native';
import { useCallback } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { formatAtomicAmount } from '@/features/swap/swap.math';
import type { SwapEntryMode, SwapToken } from '@/features/swap/swap.types';
import { semantic, tokens } from '@/theme';
import { sumAtomicStrings, useSwapController } from '@/features/swap/useSwapController';
import { exchangeRate } from '@/features/swap/swap.display';
import { SwapReview } from '@/features/swap/components/SwapReview';

function modeFrom(value: string | string[] | undefined): SwapEntryMode {
  const item = Array.isArray(value) ? value[0] : value;
  return item === 'buy' || item === 'sell' ? item : 'swap';
}

function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'Unavailable';
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  });
}

function inlineSwapError(message: string, inputSymbol: string): string {
  const normalized = message.toLowerCase();
  if (normalized.includes('balance') && normalized.includes('lower'))
    return `Insufficient ${inputSymbol} balance`;
  if (normalized.includes('network') && normalized.includes('cost'))
    return 'Not enough SOL for network fees';
  if (normalized.includes('0.005 sol')) return 'Not enough SOL for network fees';
  if (
    normalized.includes('cancel') ||
    normalized.includes('reject') ||
    normalized.includes('declin')
  )
    return 'Swap cancelled in wallet';
  if (
    normalized.includes('rate') ||
    normalized.includes('busy') ||
    normalized.includes('refreshing')
  )
    return 'Prices are busy — try again';
  if (normalized.includes('route')) return 'No swap route available';
  if (normalized.includes('expired') || normalized.includes('expiry'))
    return 'Price expired — refresh and try again';
  if (normalized.includes('slippage') || normalized.includes('price moved'))
    return 'Price moved — refresh and try again';
  if (
    normalized.includes('different transaction') ||
    normalized.includes('changed') ||
    normalized.includes('unexpected mint')
  )
    return 'Swap changed — refresh price';
  if (normalized.includes('wallet') && normalized.includes('cannot sign'))
    return 'Wallet unavailable on this device';
  if (normalized.includes('connection') || normalized.includes('network request'))
    return 'Connection lost — try again';
  return message.length <= 48 ? message : 'Swap could not continue — tap to retry';
}

function SwapPairIcon() {
  return (
    <Svg width={17} height={17} viewBox="0 0 24 24">
      <Path
        d="M8 3 4 7l4 4M4 7h16M16 21l4-4-4-4M20 17H4"
        fill="none"
        stroke={tokens.colors.primary}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

type InlineActionTone = 'default' | 'loading' | 'error' | 'warning' | 'success';

function InlineSwapAction({
  label,
  tone = 'default',
  onPress,
  disabled = false,
  token,
  accessibilityHint,
}: {
  label: string;
  tone?: InlineActionTone;
  onPress?: () => void;
  disabled?: boolean;
  token?: SwapToken;
  accessibilityHint?: string;
}) {
  const loading = tone === 'loading';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: disabled || loading, busy: loading }}
      disabled={disabled || loading || !onPress}
      onPress={onPress}
      style={({ pressed }) => [
        styles.inlineAction,
        tone === 'error' && styles.inlineActionError,
        tone === 'warning' && styles.inlineActionWarning,
        tone === 'success' && styles.inlineActionSuccess,
        (disabled || loading || !onPress) && styles.inlineActionStatic,
        pressed && styles.inlineActionPressed,
      ]}
    >
      {loading ? <ActivityIndicator size="small" color={tokens.colors.primary} /> : null}
      <Text
        selectable={tone === 'error' || tone === 'warning'}
        numberOfLines={2}
        adjustsFontSizeToFit
        minimumFontScale={0.78}
        style={[
          styles.inlineActionText,
          tone === 'error' && styles.inlineActionTextError,
          tone === 'warning' && styles.inlineActionTextWarning,
          tone === 'success' && styles.inlineActionTextSuccess,
        ]}
      >
        {label}
      </Text>
      {token ? <TokenAvatar token={token} size={17} /> : null}
    </Pressable>
  );
}

/** Routed Swap/Buy/Sell surface backed by the same controller used by Wallet. */
export default function SwapScreen() {
  const router = useRouter();
  const focused = useIsFocused();
  const params = useLocalSearchParams<{ mode?: string; token?: string }>();
  const insets = useSafeAreaInsets();
  const mode = modeFrom(params.mode);
  const requestedMint = Array.isArray(params.token) ? params.token[0] : params.token;
  const controller = useSwapController({ mode, active: focused, requestedMint });
  const {
    wallet,
    inputToken,
    outputToken,
    amount,
    phase,
    tokenQuery,
    tokenResults,
    tokenLoading,
    tokenError,
    quote,
    quoteExpired,
    quoteError,
    reviewOrder,
    slippageMode,
    customSlippage,
    customSlippageError,
    extremeConfirmation,
    failure,
    resultMessage,
    inputBalanceAtomic,
    outputBalanceAtomic,
    inputUsd,
    outputUi,
    outputUsd,
    balanceError,
    isDangerousSlippage,
    isExtremeSlippage,
    interactionBusy,
    pendingReady,
    pendingError,
    amountAtomic,
    prepareReview,
    setManualAmount,
    openPicker,
    selectToken,
    cancelPicker,
    setTokenQuery,
    reversePair,
    retry,
    setSlippageMode,
    setCustomSlippage,
    setExtremeConfirmation,
    balancePercent,
  } = controller;
  const close = useCallback(() => {
    if (interactionBusy && phase !== 'unknown') return;
    router.back();
  }, [interactionBusy, phase, router]);
  const receiveDecimals = outputToken.decimals;
  const feeOrder = quoteExpired
    ? null
    : (reviewOrder ?? (quote?.kind === 'signable' ? quote : null));
  const feeAtomic = feeOrder?.fees.providerFeeAtomic;
  const providerFeeMint = feeOrder?.fees.providerFeeMint;
  const networkFeeAtomic = feeOrder
    ? sumAtomicStrings(
        feeOrder.fees.signatureFeeLamports,
        feeOrder.fees.priorityFeeLamports,
        feeOrder.fees.rentFeeLamports,
      )
    : null;
  const providerFeeLabel =
    feeAtomic && providerFeeMint
      ? providerFeeMint === inputToken.address
        ? `${formatAtomicAmount(feeAtomic, inputToken.decimals, 8)} ${inputToken.symbol}`
        : providerFeeMint === outputToken.address
          ? `${formatAtomicAmount(feeAtomic, outputToken.decimals, 8)} ${outputToken.symbol}`
          : `${feeAtomic} atomic (${providerFeeMint.slice(0, 4)}…${providerFeeMint.slice(-4)})`
      : 'Unavailable';

  const action =
    phase === 'confirmed' ? (
      <InlineSwapAction
        label="Swap confirmed"
        tone="success"
        onPress={close}
        accessibilityHint={resultMessage ?? 'Close this swap'}
      />
    ) : phase === 'unknown' ? (
      <SwapReview controller={controller} />
    ) : pendingError ? (
      <InlineSwapAction
        label="Retry pending status check"
        tone="error"
        onPress={() => void controller.reconcilePending()}
        accessibilityHint={pendingError}
      />
    ) : phase === 'failed' ? (
      <InlineSwapAction
        label={inlineSwapError(failure ?? 'Swap could not continue.', inputToken.symbol)}
        tone="error"
        onPress={retry}
        accessibilityHint="Tap to refresh the quote and try again"
      />
    ) : phase === 'ordering' ? (
      <InlineSwapAction label="Building your swap…" tone="loading" />
    ) : phase === 'validating' ? (
      <InlineSwapAction
        label={reviewOrder ? 'Checking wallet response…' : 'Checking the swap…'}
        tone="loading"
      />
    ) : phase === 'simulating' ? (
      <InlineSwapAction label="Checking the expected result…" tone="loading" />
    ) : phase === 'awaiting_signature' ? (
      <InlineSwapAction label="Approve the swap in your wallet" tone="loading" />
    ) : phase === 'executing' ? (
      <InlineSwapAction label="Sending swap…" tone="loading" />
    ) : phase === 'reviewing' && reviewOrder ? (
      <SwapReview controller={controller} />
    ) : !amountAtomic ? (
      <InlineSwapAction label="Enter an amount" disabled />
    ) : balanceError ? (
      <InlineSwapAction
        label={inlineSwapError(balanceError, inputToken.symbol)}
        tone="error"
        disabled
      />
    ) : customSlippageError ? (
      <InlineSwapAction label={customSlippageError} tone="error" disabled />
    ) : isExtremeSlippage && extremeConfirmation.trim().toUpperCase() !== 'CONFIRM' ? (
      <InlineSwapAction label="Type CONFIRM to continue" tone="warning" disabled />
    ) : quoteError ? (
      <InlineSwapAction
        label={inlineSwapError(quoteError, inputToken.symbol)}
        tone="error"
        onPress={retry}
        accessibilityHint="Tap to request a new price"
      />
    ) : quoteExpired ? (
      <InlineSwapAction
        label="Price expired — refresh"
        tone="error"
        onPress={retry}
        accessibilityHint="Refresh the quote before reviewing"
      />
    ) : !quote ? (
      <InlineSwapAction label="Getting the latest price…" tone="loading" />
    ) : !wallet.connected ? (
      <InlineSwapAction
        label="Connect wallet to swap"
        onPress={() => {
          Keyboard.dismiss();
          void prepareReview();
        }}
      />
    ) : !pendingReady ? (
      <InlineSwapAction label="Checking previous swap…" tone="loading" />
    ) : (
      <InlineSwapAction
        label="Review swap"
        onPress={() => {
          Keyboard.dismiss();
          void prepareReview();
        }}
      />
    );

  if (phase === 'picker') {
    return (
      <KeyboardAvoidingView
        style={styles.overlay}
        behavior="padding"
        enabled={Platform.OS === 'ios'}
      >
        <Pressable
          style={styles.backdrop}
          onPress={cancelPicker}
          accessibilityRole="button"
          accessibilityLabel="Close token picker"
        />
        <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 12) }]}>
          <View style={styles.body}>
            <TextInput
              autoFocus
              value={tokenQuery}
              onChangeText={setTokenQuery}
              placeholder="Search token or paste mint"
              placeholderTextColor={semantic.text.faint}
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.searchInput}
            />
            {tokenLoading ? (
              <ActivityIndicator color={tokens.colors.primary} style={styles.loader} />
            ) : null}
            {tokenError ? (
              <Text selectable style={styles.errorText}>
                {tokenError}
              </Text>
            ) : null}
            <ScrollView
              keyboardShouldPersistTaps="handled"
              style={styles.tokenList}
              showsVerticalScrollIndicator={false}
            >
              {tokenResults.map((token) => (
                <Pressable
                  key={token.address}
                  onPress={() => selectToken(token)}
                  style={styles.tokenResult}
                >
                  <TokenAvatar token={token} size={32} />
                  <View style={styles.tokenResultCopy}>
                    <Text style={styles.tokenSymbol}>{token.symbol}</Text>
                    <Text style={styles.tokenName} numberOfLines={1}>
                      {token.name}
                    </Text>
                  </View>
                  <Text
                    selectable
                    style={styles.mintText}
                  >{`${token.address.slice(0, 4)}…${token.address.slice(-4)}`}</Text>
                </Pressable>
              ))}
            </ScrollView>
          </View>
        </View>
      </KeyboardAvoidingView>
    );
  }

  return (
    <KeyboardAvoidingView style={styles.overlay} behavior="padding" enabled={Platform.OS === 'ios'}>
      <Pressable
        style={styles.backdrop}
        onPress={close}
        accessibilityRole="button"
        accessibilityLabel="Close trade sheet"
      />
      <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 12) }]}>
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.body}
        >
          <View style={styles.composer}>
            <AssetAmount
              label="You pay"
              token={inputToken}
              balanceAtomic={inputBalanceAtomic}
              amount={amount}
              usd={inputUsd}
              editable
              locked={mode === 'sell'}
              disabled={interactionBusy}
              invalid={!!balanceError}
              onAmount={setManualAmount}
              onAsset={() => openPicker('input')}
              onBalancePercent={balancePercent}
            />
            <View style={styles.seam}>
              {mode === 'swap' ? (
                <Pressable
                  disabled={interactionBusy}
                  onPress={reversePair}
                  accessibilityRole="button"
                  accessibilityLabel="Reverse pair"
                  accessibilityState={{ disabled: interactionBusy }}
                  style={styles.reverseButton}
                >
                  <SwapPairIcon />
                </Pressable>
              ) : null}
            </View>
            <AssetAmount
              label="You receive"
              token={outputToken}
              balanceAtomic={outputBalanceAtomic}
              amount={outputUi}
              usd={outputUsd}
              editable={false}
              locked={mode === 'buy'}
              disabled={interactionBusy}
              onAmount={() => {}}
              onAsset={() => openPicker('output')}
            />
          </View>
          <View style={styles.quoteCard}>
            <MetricRow
              label="Exchange rate"
              value={
                quote && !quoteExpired
                  ? exchangeRate(quote, inputToken, outputToken)
                  : 'Unavailable'
              }
            />
            <MetricRow
              label="Minimum received"
              value={
                quote && !quoteExpired
                  ? `${formatAtomicAmount(quote.minimumOutAmountAtomic, receiveDecimals, 8)} ${outputToken.symbol}`
                  : 'Unavailable'
              }
            />
            <MetricRow
              label="Price impact"
              value={
                !quote || quoteExpired || quote.priceImpactPct == null
                  ? 'Unavailable'
                  : `${quote.priceImpactPct.toFixed(2)}%`
              }
            />
            <MetricRow label="Provider fee" value={providerFeeLabel} />
            <MetricRow
              label="Network fees"
              value={
                networkFeeAtomic
                  ? `${formatAtomicAmount(networkFeeAtomic, 9, 8)} SOL`
                  : 'Unavailable'
              }
            />
            <View style={styles.slippageRow}>
              <Text style={styles.metricLabel}>Slippage</Text>
              <View style={styles.slippageOptions}>
                {(['auto', 'fixed', 'custom'] as const).map((item) => (
                  <Pressable
                    key={item}
                    disabled={interactionBusy}
                    onPress={() => setSlippageMode(item)}
                    style={[styles.smallChoice, slippageMode === item && styles.smallChoiceActive]}
                  >
                    <Text
                      style={[
                        styles.smallChoiceText,
                        slippageMode === item && styles.smallChoiceTextActive,
                      ]}
                    >
                      {item === 'fixed' ? '0.5%' : item}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>
            {slippageMode === 'custom' ? (
              <TextInput
                value={customSlippage}
                editable={!interactionBusy}
                onChangeText={setCustomSlippage}
                keyboardType="decimal-pad"
                placeholder="0–50%"
                placeholderTextColor={semantic.text.faint}
                style={styles.customInput}
                accessibilityLabel="Custom slippage percentage"
              />
            ) : null}
          </View>
          {isDangerousSlippage ? (
            <Text style={styles.warning}>
              High slippage applies only to this trade and resets when this surface closes.
            </Text>
          ) : null}
          {isExtremeSlippage ? (
            <TextInput
              value={extremeConfirmation}
              editable={!interactionBusy}
              onChangeText={setExtremeConfirmation}
              autoCapitalize="characters"
              placeholder="Type CONFIRM for slippage above 15%"
              placeholderTextColor={semantic.text.faint}
              style={styles.confirmInput}
            />
          ) : null}
          {action}
        </ScrollView>
      </View>
    </KeyboardAvoidingView>
  );
}

function TokenAvatar({ token, size }: { token: SwapToken; size: number }) {
  return token.logoURI ? (
    <Image
      source={token.logoURI}
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: semantic.background.lift,
      }}
      contentFit="cover"
    />
  ) : (
    <View style={[styles.tokenFallback, { width: size, height: size, borderRadius: size / 2 }]}>
      <Text style={styles.tokenFallbackText}>{token.symbol.slice(0, 1).toUpperCase()}</Text>
    </View>
  );
}

function AssetAmount({
  label,
  token,
  balanceAtomic,
  amount,
  usd,
  editable,
  locked,
  disabled = false,
  invalid = false,
  onAmount,
  onAsset,
  onBalancePercent,
}: {
  label: string;
  token: SwapToken;
  balanceAtomic?: string;
  amount: string;
  usd: number | null;
  editable: boolean;
  locked: boolean;
  disabled?: boolean;
  invalid?: boolean;
  onAmount: (value: string) => void;
  onAsset: () => void;
  onBalancePercent?: (percent: number) => void;
}) {
  return (
    <View style={styles.assetBlock}>
      <View style={styles.assetMeta}>
        <Text style={styles.assetLabel}>{label}</Text>
        <View style={styles.balanceRow}>
          <Text style={styles.balanceText}>
            Balance {balanceAtomic ? formatAtomicAmount(balanceAtomic, token.decimals, 6) : '—'}
          </Text>
          {onBalancePercent && balanceAtomic ? (
            <View style={styles.balanceActions}>
              {[25, 50, 100].map((percent, index) => (
                <View key={percent} style={styles.balanceActionGroup}>
                  {index > 0 ? <Text style={styles.balanceActionSeparator}>·</Text> : null}
                  <Pressable
                    disabled={disabled}
                    onPress={() => onBalancePercent(percent)}
                    hitSlop={9}
                    accessibilityRole="button"
                    accessibilityLabel={`Use ${percent} percent of available ${token.symbol} balance`}
                    accessibilityState={{ disabled }}
                    style={styles.balanceAction}
                  >
                    <Text style={styles.balanceActionText}>{percent}%</Text>
                  </Pressable>
                </View>
              ))}
            </View>
          ) : null}
        </View>
      </View>
      <View style={styles.assetMain}>
        <Pressable
          disabled={locked || disabled}
          onPress={onAsset}
          accessibilityState={{ disabled: locked || disabled }}
          style={[styles.assetSelector, (locked || disabled) && styles.assetSelectorLocked]}
        >
          <TokenAvatar token={token} size={26} />
          <Text style={styles.assetSymbol}>{token.symbol}</Text>
          {!locked ? (
            <MaterialIcons name="expand-more" size={17} color={semantic.text.dim} />
          ) : null}
        </Pressable>
        <View style={styles.amountColumn}>
          {editable ? (
            <TextInput
              value={amount}
              editable={!disabled}
              onChangeText={(value) => onAmount(value.replace(/[^\d.]/g, ''))}
              keyboardType="decimal-pad"
              returnKeyType="done"
              onSubmitEditing={Keyboard.dismiss}
              placeholder="0"
              placeholderTextColor={semantic.text.faint}
              style={[styles.amountInput, invalid && styles.amountInputInvalid]}
              accessibilityLabel={`${label} amount`}
            />
          ) : (
            <Text
              selectable
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.62}
              style={[
                styles.amountOutput,
                amount.length > 9 && styles.amountOutputCompact,
                amount.length > 13 && styles.amountOutputDense,
                amount === '0' && styles.amountMuted,
              ]}
            >
              {amount}
            </Text>
          )}
          <Text style={styles.amountUsd}>
            {amount.trim() === '' || Number(amount) === 0 ? '$0.00' : formatUsd(usd)}
          </Text>
        </View>
      </View>
    </View>
  );
}

function MetricRow({
  label,
  value,
  positive = false,
}: {
  label: string;
  value: string;
  positive?: boolean;
}) {
  return (
    <View style={styles.metricRow}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text selectable style={[styles.metricValue, positive && styles.metricPositive]}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(1, 13, 19, 0.72)' },
  sheet: {
    maxHeight: '92%',
    minHeight: 280,
    backgroundColor: semantic.background.screen,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderCurve: 'continuous',
    borderWidth: 1,
    borderBottomWidth: 0,
    borderColor: semantic.border.muted,
    overflow: 'hidden',
  },
  body: { padding: 14, gap: 10 },
  composer: {
    borderWidth: 1,
    borderColor: semantic.border.muted,
    borderRadius: 12,
    borderCurve: 'continuous',
    overflow: 'hidden',
    backgroundColor: semantic.background.surface,
  },
  assetBlock: { padding: 12, gap: 8 },
  assetMeta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  assetLabel: {
    color: semantic.text.dim,
    fontFamily: 'monospace',
    fontSize: 9,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  balanceRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  balanceText: { color: semantic.text.faint, fontFamily: 'monospace', fontSize: 8 },
  balanceActions: { flexDirection: 'row', alignItems: 'center' },
  balanceActionGroup: { flexDirection: 'row', alignItems: 'center' },
  balanceActionSeparator: { color: semantic.border.muted, fontFamily: 'monospace', fontSize: 11 },
  balanceAction: {
    minHeight: 32,
    paddingHorizontal: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: -8,
  },
  balanceActionText: {
    color: semantic.text.accentDim,
    fontFamily: 'monospace',
    fontSize: 10,
    fontWeight: '900',
    fontVariant: ['tabular-nums'],
  },
  assetMain: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  assetSelector: {
    minWidth: 112,
    minHeight: 42,
    paddingHorizontal: 9,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    borderWidth: 1,
    borderColor: semantic.border.muted,
    borderRadius: 9,
    borderCurve: 'continuous',
    backgroundColor: semantic.background.surfaceRaised,
  },
  assetSelectorLocked: { borderColor: 'transparent', backgroundColor: semantic.background.surface },
  assetSymbol: { color: semantic.text.primary, fontSize: 15, fontWeight: '800' },
  amountColumn: { flex: 1, alignItems: 'flex-end' },
  amountInput: {
    width: '100%',
    padding: 0,
    color: semantic.text.primary,
    fontSize: 34,
    lineHeight: 38,
    fontWeight: '700',
    textAlign: 'right',
    fontVariant: ['tabular-nums'],
  },
  amountInputInvalid: { color: semantic.sentiment.negative },
  amountOutput: {
    width: '100%',
    flexShrink: 1,
    color: semantic.text.primary,
    fontSize: 34,
    lineHeight: 38,
    fontWeight: '700',
    textAlign: 'right',
    fontVariant: ['tabular-nums'],
  },
  amountOutputCompact: { fontSize: 28, lineHeight: 34 },
  amountOutputDense: { fontSize: 23, lineHeight: 29 },
  amountMuted: { color: semantic.text.faint },
  amountUsd: {
    color: semantic.text.faint,
    fontFamily: 'monospace',
    fontSize: 8,
    fontVariant: ['tabular-nums'],
  },
  seam: {
    height: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: semantic.border.muted,
    zIndex: 2,
  },
  reverseButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: semantic.border.muted,
    backgroundColor: tokens.colors.walletCore,
  },
  quoteCard: {
    borderWidth: 1,
    borderColor: semantic.border.muted,
    borderRadius: 9,
    borderCurve: 'continuous',
    backgroundColor: semantic.background.surface,
    overflow: 'hidden',
  },
  metricRow: {
    minHeight: 34,
    paddingHorizontal: 11,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: semantic.border.muted,
  },
  metricLabel: { color: semantic.text.dim, fontSize: 10 },
  metricValue: {
    color: semantic.text.primary,
    fontFamily: 'monospace',
    fontSize: 9,
    fontWeight: '700',
    textAlign: 'right',
    fontVariant: ['tabular-nums'],
  },
  metricPositive: { color: semantic.sentiment.positive },
  slippageRow: {
    minHeight: 38,
    paddingHorizontal: 11,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  slippageOptions: { flexDirection: 'row', gap: 4 },
  smallChoice: {
    minHeight: 27,
    paddingHorizontal: 8,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: semantic.border.muted,
    borderRadius: tokens.radius.sm,
  },
  smallChoiceActive: {
    borderColor: tokens.colors.primary,
    backgroundColor: 'rgba(17,138,178,0.11)',
  },
  smallChoiceText: {
    color: semantic.text.dim,
    fontFamily: 'monospace',
    fontSize: 8,
    textTransform: 'capitalize',
  },
  smallChoiceTextActive: { color: semantic.text.primary },
  customInput: {
    minHeight: 38,
    paddingHorizontal: 10,
    color: semantic.text.primary,
    textAlign: 'right',
    fontFamily: 'monospace',
    fontSize: 11,
    borderTopWidth: 1,
    borderTopColor: semantic.border.muted,
  },
  warning: { color: semantic.text.accentDim, fontSize: 10, lineHeight: 15, textAlign: 'center' },
  confirmInput: {
    minHeight: 42,
    paddingHorizontal: 11,
    borderWidth: 1,
    borderColor: semantic.text.accentDim,
    borderRadius: 8,
    color: semantic.text.primary,
    fontFamily: 'monospace',
    fontSize: 10,
    textAlign: 'center',
  },
  errorText: {
    color: semantic.sentiment.negative,
    fontSize: 10,
    lineHeight: 15,
    textAlign: 'center',
  },
  inlineAction: {
    minHeight: 56,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderWidth: 1,
    borderColor: semantic.border.muted,
    borderRadius: 10,
    borderCurve: 'continuous',
    backgroundColor: tokens.colors.walletCore,
  },
  inlineActionError: {
    borderColor: 'rgba(239,71,111,0.72)',
    backgroundColor: 'rgba(239,71,111,0.06)',
  },
  inlineActionWarning: {
    borderColor: 'rgba(255,209,102,0.68)',
    backgroundColor: 'rgba(255,209,102,0.06)',
  },
  inlineActionSuccess: {
    borderColor: 'rgba(6,214,160,0.72)',
    backgroundColor: 'rgba(6,214,160,0.07)',
  },
  inlineActionStatic: { opacity: 1 },
  inlineActionPressed: { opacity: 0.78 },
  inlineActionText: {
    maxWidth: '88%',
    color: semantic.text.primary,
    fontSize: 13,
    lineHeight: 17,
    fontWeight: '900',
    textAlign: 'center',
  },
  inlineActionTextError: { color: semantic.sentiment.negative },
  inlineActionTextWarning: { color: semantic.text.accentDim },
  inlineActionTextSuccess: { color: semantic.sentiment.positive },
  searchInput: {
    minHeight: 44,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: tokens.colors.primary,
    borderRadius: 9,
    color: semantic.text.primary,
    fontSize: 13,
    backgroundColor: semantic.background.surface,
  },
  loader: { paddingVertical: 12 },
  tokenList: { maxHeight: 390 },
  tokenResult: {
    minHeight: 54,
    paddingHorizontal: 6,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: semantic.border.muted,
  },
  tokenResultCopy: { flex: 1, minWidth: 0, gap: 2 },
  tokenSymbol: { color: semantic.text.primary, fontSize: 13, fontWeight: '800' },
  tokenName: { color: semantic.text.dim, fontSize: 10 },
  mintText: { color: semantic.text.faint, fontFamily: 'monospace', fontSize: 8 },
  tokenFallback: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: tokens.colors.primary,
  },
  tokenFallbackText: { color: semantic.text.primary, fontSize: 11, fontWeight: '900' },
});
