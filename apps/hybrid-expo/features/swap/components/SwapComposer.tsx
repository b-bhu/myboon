import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  findNodeHandle,
  Keyboard,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { AssetSwap, SwapTokenAvatar } from '@/features/swap/components/AssetSwap';
import { SwapTokenPicker } from '@/features/swap/components/SwapTokenPicker';
import { SwipeToConfirm } from '@/features/swap/components/SwipeToConfirm';
import { formatAtomicAmount, parseUiAmountToAtomic } from '@/features/swap/swap.math';
import { exchangeRate, exchangeRateValue, providerFee } from '@/features/swap/swap.display';
import { swapTheme as color } from '@/features/swap/swap.theme';
import { useSwapValueAnimation } from '@/features/swap/swap.motion';
import type { SwapSide } from '@/features/swap/swap.types';
import { sumAtomicStrings, type SwapController } from '@/features/swap/useSwapController';
import { useWalletSheet } from '@/features/wallet/WalletSheetProvider';
import { WalletSecondarySheet } from '@/features/wallet/WalletSecondarySheet';
import {
  createReverseGesture,
  WALLET_ACTION_MENU,
  type ReverseGestureController,
  type WalletAction,
} from '@/features/wallet/wallet-action-gesture';

type Surface = 'actions' | 'slippage' | 'details' | null;
const actionIcons = {
  swap: 'currency-exchange',
  send: 'arrow-upward',
  receive: 'arrow-downward',
  transfer: 'swap-horiz',
} as const;

type WalletSheet = Pick<ReturnType<typeof useWalletSheet>, 'isOpen' | 'open' | 'close'>;

export type SwapComposerProps = {
  active: boolean;
  surfaceKey: string;
  onBusyChange: (busy: boolean) => void;
  controller: SwapController;
  walletSheet?: WalletSheet;
  walletActions?: boolean;
};

export function SwapComposer({
  active,
  surfaceKey,
  onBusyChange,
  controller: c,
  walletSheet: walletSheetOverride,
  walletActions = true,
}: SwapComposerProps) {
  const runtimeWalletSheet = useWalletSheet();
  const walletSheet = walletSheetOverride ?? runtimeWalletSheet;
  const [surface, setSurface] = useState<Surface>(null);
  const [amountFocused, setAmountFocused] = useState(false);
  const attemptedQuote = useRef<string | null>(null);
  const reviewSession = useRef(c.wallet.sessionKey ?? c.wallet.address);
  const [comingSoon, setComingSoon] = useState<string | null>(null);
  const payInputRef = useRef<TextInput>(null);
  const actionHeadingRef = useRef<View>(null);
  const restorePayFocus = useRef(false);
  const gesture = useRef<ReverseGestureController | null>(null);
  const previousExternalSurface = useRef(surfaceKey);
  const { phase, invalidatePreparedTrade } = c;
  const latest = useRef({ c, active, surface, walletSheetOpen: walletSheet.isOpen });
  latest.current = { c, active, surface, walletSheetOpen: walletSheet.isOpen };
  const hasAmount = c.amount.trim().length > 0;
  const quoteReveal = useSwapValueAnimation(hasAmount ? 'visible' : '');

  useEffect(() => {
    const subscription = Keyboard.addListener('keyboardDidHide', () => setAmountFocused(false));
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (!active || phase !== 'confirmed' || walletSheet.isOpen || surface !== null) return;
    const requestId = c.reviewOrder?.requestId;
    const session = c.wallet.sessionKey ?? c.wallet.address;
    const timer = setTimeout(() => {
      const state = latest.current;
      if (!state.active || state.c.phase !== 'confirmed' || state.walletSheetOpen || state.surface !== null ||
          state.c.reviewOrder?.requestId !== requestId ||
          (state.c.wallet.sessionKey ?? state.c.wallet.address) !== session) return;
      if (state.c.invalidatePreparedTrade()) attemptedQuote.current = null;
    }, 2400);
    return () => clearTimeout(timer);
  }, [active, phase, walletSheet.isOpen, surface, c.reviewOrder?.requestId, c.wallet.sessionKey, c.wallet.address]);

  const cancelGesture = useCallback(() => gesture.current?.cancel(), []);
  const openActions = useCallback(() => {
    const state = latest.current;
    cancelGesture();
    if (!state.active || state.c.interactionBusy || !state.c.invalidatePreparedTrade()) return;
    attemptedQuote.current = null;
    restorePayFocus.current = payInputRef.current?.isFocused() ?? false;
    Keyboard.dismiss();
    setSurface('actions');
  }, [cancelGesture]);

  useEffect(() => {
    const recognizer = createReverseGesture({
      isEnabled: () =>
        latest.current.active &&
        ['compose', 'reviewing', 'confirmed', 'failed'].includes(latest.current.c.phase) &&
        !latest.current.c.interactionBusy &&
        latest.current.surface === null &&
        !latest.current.walletSheetOpen,
      onSingleTap: () => latest.current.c.reversePair(),
      onDoubleTap: openActions,
    });
    gesture.current = recognizer;
    return () => {
      recognizer.dispose();
      gesture.current = null;
    };
  }, [openActions]);

  useLayoutEffect(() => {
    cancelGesture();
  }, [active, c.interactionBusy, c.phase, surfaceKey, surface, walletSheet.isOpen, cancelGesture]);
  useLayoutEffect(() => {
    if (previousExternalSurface.current !== surfaceKey || walletSheet.isOpen) {
      if (phase === 'reviewing') {
        invalidatePreparedTrade();
        attemptedQuote.current = null;
        setSurface(null);
      }
    }
    previousExternalSurface.current = surfaceKey;
  }, [surfaceKey, walletSheet.isOpen, phase, invalidatePreparedTrade]);
  useEffect(() => {
    onBusyChange(
      c.interactionBusy || surface !== null || c.phase === 'picker',
    );
  }, [c.interactionBusy, c.phase, surface, onBusyChange]);
  useEffect(() => {
    if (!active) {
      if (latest.current.c.phase === 'reviewing') latest.current.c.invalidatePreparedTrade();
      attemptedQuote.current = null;
      setAmountFocused(false);
      setSurface(null);
      setComingSoon(null);
      restorePayFocus.current = false;
    }
  }, [active, c.phase]);
  useEffect(() => {
    if (!comingSoon) return;
    AccessibilityInfo.announceForAccessibility(comingSoon);
    const timer = setTimeout(() => setComingSoon(null), 1800);
    return () => clearTimeout(timer);
  }, [comingSoon]);

  function rememberFocus() {
    cancelGesture();
    restorePayFocus.current = payInputRef.current?.isFocused() ?? false;
    Keyboard.dismiss();
  }
  function restoreFocus() {
    requestAnimationFrame(() => {
      if (!latest.current.active) return;
      if (restorePayFocus.current) payInputRef.current?.focus();
      else {
        const handle = findNodeHandle(actionHeadingRef.current);
        if (handle !== null) AccessibilityInfo.setAccessibilityFocus(handle);
      }
      restorePayFocus.current = false;
    });
  }
  function closeSurface() {
    cancelGesture();
    if (c.interactionBusy && c.phase !== 'unknown') return;
    if (c.phase === 'picker') c.cancelPicker();
    setSurface(null);
    restoreFocus();
  }
  function openSurface(next: Surface) {
    rememberFocus();
    if (c.interactionBusy) return;
    if (next === 'slippage') {
      if (!c.invalidatePreparedTrade()) return;
      attemptedQuote.current = null;
    }
    setSurface(next);
  }
  function openPicker(side: SwapSide) {
    rememberFocus();
    if (c.interactionBusy) return;
    setSurface(null);
    c.openPicker(side);
  }
  function chooseAction(action: WalletAction) {
    cancelGesture();
    if (c.interactionBusy) return;
    setSurface(null);
    if (action !== 'swap')
      setComingSoon(`${WALLET_ACTION_MENU.find((item) => item.id === action)?.label}: Coming soon`);
    restoreFocus();
  }

  // Preparing an unsigned order only updates the visible inline review. Signing
  // and submission still require a separate, explicit swipe on that exact order.
  useEffect(() => {
    if (!active || amountFocused || surface !== null || walletSheet.isOpen || c.phase !== 'compose' ||
        !c.wallet.connected || !c.pendingReady || c.pendingError || c.interactionBusy ||
        !c.amountAtomic || !c.balancesResolved || c.balancesError || c.balanceError ||
        c.customSlippageError || c.quoteError || c.quoteExpired || !c.quote ||
        (c.isExtremeSlippage && c.extremeConfirmation.trim().toUpperCase() !== 'CONFIRM')) return;
    if (attemptedQuote.current === c.quote.requestId) return;
    attemptedQuote.current = c.quote.requestId;
    reviewSession.current = c.wallet.sessionKey ?? c.wallet.address;
    cancelGesture();
    void c.prepareReview();
  }, [active, amountFocused, surface, walletSheet.isOpen, c, cancelGesture]);

  let amountError: string | null = null;
  if (c.amount.trim()) {
    try { parseUiAmountToAtomic(c.amount, c.inputToken.decimals); }
    catch (failure) { amountError = failure instanceof Error ? failure.message : 'Enter a valid amount.'; }
  }
  const error = c.phase === 'confirmed' ? null :
    c.failure ?? amountError ?? c.balanceError ?? c.balancesError ?? c.quoteError ??
    c.customSlippageError ?? c.pendingError;
  const pickerOpen = c.phase === 'picker';
  const order = c.reviewOrder ?? (!c.quoteExpired ? c.quote : null);
  const feeOrder = order?.kind === 'signable' ? order : null;
  const networkFees = feeOrder && [feeOrder.fees.signatureFeeLamports, feeOrder.fees.priorityFeeLamports, feeOrder.fees.rentFeeLamports].every((fee) => fee !== null)
    ? `${formatAtomicAmount(sumAtomicStrings(feeOrder.fees.signatureFeeLamports, feeOrder.fees.priorityFeeLamports, feeOrder.fees.rentFeeLamports), 9, 9)} SOL` : 'Unavailable';
  const minimum = order ? formatAtomicAmount(order.minimumOutAmountAtomic, c.outputToken.decimals, 8) : '—';
  const numericRate = exchangeRateValue(order, c.inputToken, c.outputToken);
  const rate = numericRate === null ? '—' : numericRate.toLocaleString('en-US', { maximumSignificantDigits: 6 });
  const canConfirm = active && !amountFocused && surface === null && !walletSheet.isOpen &&
    c.phase === 'reviewing' && !!c.reviewOrder && !c.quoteExpired &&
    c.wallet.connected && c.pendingReady && !c.pendingError && !c.interactionBusy &&
    c.reviewOrder.taker === c.wallet.address &&
    reviewSession.current === (c.wallet.sessionKey ?? c.wallet.address) &&
    c.reviewOrder.inputMint === c.inputToken.address &&
    c.reviewOrder.outputMint === c.outputToken.address &&
    c.reviewOrder.inAmountAtomic === c.amountAtomic &&
    (!c.reviewOrder.expiresAt || Date.parse(c.reviewOrder.expiresAt) > Date.now()) &&
    !c.balanceError && !c.customSlippageError &&
    (!c.isExtremeSlippage || c.extremeConfirmation.trim().toUpperCase() === 'CONFIRM') &&
    (!c.simulationWarning || c.simulationWarningAccepted);
  let status: string | null = null;
  let statusAction: (() => void) | undefined;
  let loading = false;
  if (c.phase === 'confirmed') status = 'Swap complete';
  else if (c.phase === 'unknown') { status = 'Check pending swap'; statusAction = () => void c.reconcilePending(); }
  else if (c.interactionBusy) {
    status = c.phase === 'awaiting_signature' ? 'Confirm in your wallet' :
      c.phase === 'executing' ? 'Sending swap…' : 'Preparing your swap…';
    loading = true;
  } else if (!c.wallet.connected) { status = 'Connect Solana wallet'; statusAction = () => walletSheet.open('solana'); }
  else if (c.pendingError) { status = 'Retry pending status check'; statusAction = () => void c.reconcilePending(); }
  else if (!c.pendingReady) { status = 'Checking previous swap…'; loading = true; }
  else if (c.phase === 'failed' || c.quoteError || c.quoteExpired) { status = 'Refresh quote'; statusAction = c.retry; }
  else if (c.balancesError) { status = 'Retry balance'; statusAction = () => void c.retryBalances().catch(() => {}); }
  else if (!c.amountAtomic) status = amountError ?? 'Enter an amount';
  else if (!c.balancesResolved) { status = 'Checking balance…'; loading = true; }
  else if (c.balanceError || c.customSlippageError) status = c.balanceError ?? c.customSlippageError;
  else if (c.isExtremeSlippage && c.extremeConfirmation.trim().toUpperCase() !== 'CONFIRM') {
    status = 'Confirm slippage in settings'; statusAction = () => openSurface('slippage');
  } else if (!c.quote) { status = 'Getting the latest price…'; loading = true; }
  else if (amountFocused) status = 'Finish entering amount';
  else if (c.simulationWarning && !c.simulationWarningAccepted) {
    status = 'Acknowledge simulation unavailable'; statusAction = () => c.setSimulationWarningAccepted(true);
  } else if (!canConfirm) { status = 'Preparing your swap…'; loading = true; }

  const heading = c.mode === 'swap' ? 'Swap' : `${c.mode === 'buy' ? 'Buy' : 'Sell'} ${c.selectedToken?.symbol ?? ''}`.trim();
  return (
    <View>
      <View style={styles.heading}>
        {walletActions ? <Pressable
          ref={actionHeadingRef}
          onPress={openActions}
          disabled={c.interactionBusy}
          style={styles.actionHeading}
          accessibilityRole="button"
          accessibilityLabel="Swap, choose wallet action"
          accessibilityHint="Opens Swap, Send, Receive and Transfer"
          accessibilityState={{ disabled: c.interactionBusy, expanded: surface === 'actions' }}
        >
          <Text style={styles.actionName}>{heading}</Text>
          <MaterialIcons name="expand-more" size={22} color={color.navy} />
        </Pressable> : <View ref={actionHeadingRef}><Text accessibilityRole="header" style={styles.actionName}>{heading}</Text></View>}
      </View>
      <AssetSwap
        inputToken={c.inputToken} outputToken={c.outputToken} amount={c.amount}
        outputAmount={c.outputUi} inputUsd={c.inputUsd} outputUsd={c.outputUsd}
        inputBalance={c.inputBalanceAtomic} outputBalance={c.outputBalanceAtomic}
        busy={c.interactionBusy} payInputRef={payInputRef}
        inputLocked={c.mode === 'sell'} outputLocked={c.mode === 'buy'} canReverse={c.mode === 'swap'}
        onAmount={(value) => { cancelGesture(); attemptedQuote.current = null; c.setManualAmount(value); }}
        onAmountFocus={() => setAmountFocused(true)} onAmountBlur={() => setAmountFocused(false)}
        onPicker={openPicker} onReverse={() => gesture.current?.handleTap()}
        onBalancePercent={(percent) => { cancelGesture(); attemptedQuote.current = null; c.balancePercent(percent); }}
      >
        {hasAmount ? <Animated.View style={quoteReveal}>
        <View style={styles.quoteStrip}>
          <View style={styles.metric}>
            <Text style={styles.metricLabel}>Exchange rate</Text>
            <View accessible accessibilityLabel={exchangeRate(order, c.inputToken, c.outputToken)} style={styles.compactValue}>
              <Text style={styles.metricValue}>1</Text><SwapTokenAvatar token={c.inputToken} size={14} />
              <Text style={styles.metricValue}>= {rate}</Text><SwapTokenAvatar token={c.outputToken} size={14} />
            </View>
          </View>
          <Pressable style={styles.metric} onPress={() => openSurface('slippage')} disabled={c.interactionBusy}
            accessibilityRole="button" accessibilityLabel="Slippage settings" accessibilityState={{ disabled: c.interactionBusy }}>
            <Text style={styles.metricLabel}>Slippage</Text>
            <Text style={styles.metricValue}>{c.slippageMode === 'auto' ? 'Auto' : c.slippageBps === undefined ? 'Invalid' : `${c.slippageBps / 100}%`} ⌄</Text>
          </Pressable>
          <View style={styles.metric}>
            <Text style={styles.metricLabel}>Minimum received</Text>
            <View accessible accessibilityLabel={`Minimum received ${minimum} ${c.outputToken.symbol}`} style={styles.compactValue}>
              <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75} style={styles.metricValue}>{minimum}</Text><SwapTokenAvatar token={c.outputToken} size={14} />
            </View>
          </View>
        </View>
        <Pressable style={styles.feeToggle} onPress={() => openSurface('details')} disabled={c.interactionBusy}
          accessibilityRole="button" accessibilityLabel="Swap fees and route details"
          accessibilityHint="Opens the swap details dialog"
          accessibilityState={{ disabled: c.interactionBusy, expanded: surface === 'details' }}>
          <Text style={[styles.feeText, styles.feeSummary]}>{feeOrder ? `Network ${networkFees} · Provider ${providerFee(feeOrder, c.inputToken, c.outputToken)}` : 'Fees not quoted'}</Text>
          <Text style={styles.feeText}>Details ⌄</Text>
        </Pressable>
        </Animated.View> : null}
        {error ? <Text selectable accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
        {c.simulationWarning ? <Text selectable accessibilityRole="alert" style={styles.inlineWarning}>{c.simulationWarning}</Text> : null}
        {c.phase === 'unknown' && c.resultMessage ? <Text selectable style={styles.inlineWarning}>{c.resultMessage}</Text> : null}
        {canConfirm ? <SwipeToConfirm key={c.reviewOrder?.requestId} receiveAmount={c.outputUi} outputToken={c.outputToken}
          onComplete={() => { cancelGesture(); Keyboard.dismiss(); void c.confirmTrade(); }} /> :
          <Pressable disabled={!statusAction || loading} onPress={() => { Keyboard.dismiss(); statusAction?.(); }}
            accessibilityRole="button" accessibilityLabel={status ?? 'Preparing swap'}
            accessibilityState={{ disabled: !statusAction || loading, busy: loading }}
            style={[styles.inlineAction, c.phase === 'confirmed' && styles.inlineSuccess]}>
            <View style={[styles.statusThumb, c.phase === 'confirmed' && styles.successThumb]}>
              {loading ? <ActivityIndicator size="small" color={color.gold} /> : <MaterialIcons name={c.phase === 'confirmed' ? 'check' : 'arrow-forward'} size={21} color={color.navy} />}
            </View>
            <View style={styles.statusCopy}><Text style={styles.statusLabel}>{status}</Text>
              {c.phase === 'confirmed' ? <Text selectable style={styles.successValue}>Received {c.outputUi} {c.outputToken.symbol}</Text> : null}
            </View>
          </Pressable>}
        <>{c.phase === 'confirmed' && c.resultMessage ? <Text accessibilityLiveRegion="polite" style={styles.srStatus}>{c.resultMessage}</Text> : null}</>
      </AssetSwap>
      {comingSoon ? <Text accessibilityLiveRegion="polite" style={styles.feedback}>{comingSoon}</Text> : null}
      <WalletSecondarySheet
        visible={active && (surface !== null || pickerOpen)}
        title={
          pickerOpen
            ? `Choose ${c.pickerSide === 'input' ? 'Pay' : 'Receive'} asset`
            : surface === 'actions'
              ? 'Wallet actions'
              : surface === 'slippage'
                ? 'Slippage settings'
                : 'Swap details'
        }
        onClose={closeSurface}
        busy={c.interactionBusy && c.phase !== 'unknown'}
        presentation={surface === 'details' ? 'dialog' : 'sheet'}
      >
        {pickerOpen ? (
          <SwapTokenPicker
            query={c.tokenQuery}
            onQuery={c.setTokenQuery}
            tokens={c.tokenResults}
            loading={c.tokenLoading}
            error={c.tokenError}
            onRetry={() => c.openPicker(c.pickerSide)}
            onSelect={(token) => {
              c.selectToken(token);
              restoreFocus();
            }}
          />
        ) : null}
        {surface === 'actions' && !pickerOpen
          ? WALLET_ACTION_MENU.map(({ id, label: name }) => (
              <Pressable
                key={id}
                onPress={() => chooseAction(id)}
                style={styles.actionOption}
                accessibilityRole="button"
                accessibilityLabel={name}
                accessibilityHint={id === 'swap' ? 'Keep Swap selected' : 'Coming soon'}
              >
                <MaterialIcons name={actionIcons[id]} size={22} color={color.gold} />
                <View style={styles.actionCopy}>
                  <Text style={styles.optionName}>{name}</Text>
                  <Text style={styles.optionHint}>
                    {id === 'swap' ? 'Exchange Solana assets' : 'Coming soon'}
                  </Text>
                </View>
                {id === 'swap' ? <MaterialIcons name="check" size={22} color={color.gold} /> : null}
              </Pressable>
            ))
          : null}
        {surface === 'details' && !pickerOpen ? <View style={styles.fees}>
          <FeeDetail label="Slippage tolerance" value={order ? `${order.slippageBps / 100}%` : 'Unavailable'} />
          <FeeDetail label="Price impact" value={order?.priceImpactPct == null ? 'Unavailable' : `${order.priceImpactPct.toLocaleString('en-US', { maximumFractionDigits: 2 })}%`} />
          <FeeDetail label="Provider fee" value={feeOrder ? providerFee(feeOrder, c.inputToken, c.outputToken) : 'Unavailable'} />
          <FeeDetail label="Signature fee" value={feeOrder?.fees.signatureFeeLamports == null ? 'Unavailable' : `${formatAtomicAmount(feeOrder.fees.signatureFeeLamports, 9, 9)} SOL`} />
          <FeeDetail label="Priority fee" value={feeOrder?.fees.priorityFeeLamports == null ? 'Unavailable' : `${formatAtomicAmount(feeOrder.fees.priorityFeeLamports, 9, 9)} SOL`} />
          <FeeDetail label="Account creation" value={feeOrder?.fees.rentFeeLamports == null ? 'Unavailable' : `${formatAtomicAmount(feeOrder.fees.rentFeeLamports, 9, 9)} SOL`} />
          <FeeDetail label="MyBoon fee" value={feeOrder ? feeOrder.fees.myboonFeeAtomic : 'Unavailable'} />
          <FeeDetail label="Route" value={order ? order.route.map((step) => `${step.label} ${step.percent}%`).join(' · ') || order.router : 'Unavailable'} />
        </View> : null}
        {surface === 'slippage' ? (
          <>
            <Text style={styles.darkNote}>
              Auto uses the provider’s tolerance. Custom slippage supports up to 50%.
            </Text>
            <View style={styles.slipOptions}>
              {(['auto', 'fixed', 'custom'] as const).map((mode) => (
                <Pressable
                  key={mode}
                  onPress={() => c.setSlippageMode(mode)}
                  accessibilityRole="button"
                  accessibilityLabel={
                    mode === 'fixed' ? '0.5 percent slippage' : `${mode} slippage`
                  }
                  accessibilityState={{ selected: c.slippageMode === mode }}
                  style={[styles.slipChoice, c.slippageMode === mode && styles.selectedChoice]}
                >
                  <Text style={styles.choiceText}>
                    {mode === 'fixed' ? '0.5%' : mode === 'auto' ? 'Auto' : 'Custom'}
                  </Text>
                </Pressable>
              ))}
            </View>
            {c.slippageMode === 'custom' ? (
              <TextInput
                value={c.customSlippage}
                onChangeText={c.setCustomSlippage}
                keyboardType="decimal-pad"
                style={styles.slippageInput}
                accessibilityLabel="Custom slippage percentage"
                placeholder="0–50%"
                placeholderTextColor={color.dim}
              />
            ) : null}
            {c.isDangerousSlippage ? (
              <Text style={styles.warning}>
                Slippage above 5% applies only to this compose session. Leaving this screen or changing
                wallet resets it.
              </Text>
            ) : null}
            {c.isExtremeSlippage ? (
              <>
                <Text style={styles.warning}>
                  Type CONFIRM before reviewing slippage above 15%.
                </Text>
                <TextInput
                  value={c.extremeConfirmation}
                  onChangeText={c.setExtremeConfirmation}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  style={styles.slippageInput}
                  accessibilityLabel="Type CONFIRM for slippage above 15 percent"
                  placeholder="CONFIRM"
                  placeholderTextColor={color.dim}
                />
              </>
            ) : null}
            {c.customSlippageError ? (
              <Text selectable style={styles.warning}>
                {c.customSlippageError}
              </Text>
            ) : null}
            <Pressable
              onPress={closeSurface}
              style={styles.choice}
              accessibilityRole="button"
              accessibilityLabel="Return to Swap"
            >
              <Text style={styles.choiceText}>Done</Text>
            </Pressable>
          </>
        ) : null}
      </WalletSecondarySheet>
    </View>
  );
}


function FeeDetail({ label, value }: { label: string; value: string }) {
  return <View style={styles.feeRow}><Text style={styles.feeLabel}>{label}</Text><Text selectable style={styles.feeValue}>{value}</Text></View>;
}

const styles = StyleSheet.create({
  heading: {
    minHeight: 46,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  actionHeading: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 6 },
  actionName: { color: color.navy, fontSize: 20, fontWeight: '700' },
  quoteStrip: { flexDirection: 'row', gap: 6, borderTopWidth: 1, borderTopColor: color.border, paddingTop: 6 },
  metric: { flex: 1, minHeight: 44, justifyContent: 'center', gap: 4 },
  metricLabel: { color: color.dim, fontSize: 9 },
  metricValue: { color: color.text, fontSize: 10, fontVariant: ['tabular-nums'], flexShrink: 1 },
  compactValue: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  feeToggle: { minHeight: 44, gap: 6, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  feeText: { color: color.dim, fontSize: 10 },
  feeSummary: { flex: 1 },
  fees: { gap: 14, paddingVertical: 8 },
  feeRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  feeLabel: { color: color.dim, fontSize: 13, flex: 1 },
  feeValue: { color: color.text, fontSize: 13, lineHeight: 19, textAlign: 'right', flex: 1.3, fontVariant: ['tabular-nums'] },
  inlineWarning: { color: color.gold, fontSize: 12, lineHeight: 17, marginBottom: 8 },
  inlineAction: { minHeight: 54, borderWidth: 1, borderColor: color.border, borderRadius: 10, backgroundColor: color.card, flexDirection: 'row', alignItems: 'center', padding: 4, gap: 6 },
  inlineSuccess: { borderColor: color.positive },
  statusThumb: { width: 42, height: 42, borderRadius: 7, backgroundColor: color.gold, alignItems: 'center', justifyContent: 'center' },
  successThumb: { backgroundColor: color.positive },
  statusCopy: { flex: 1, alignItems: 'center', gap: 3 },
  statusLabel: { color: color.dim, fontSize: 11, textAlign: 'center' },
  successValue: { color: color.positive, fontSize: 12, fontWeight: '700', textAlign: 'center', fontVariant: ['tabular-nums'] },
  srStatus: { color: color.dim, fontSize: 10, lineHeight: 14 },
  error: {
    color: color.text,
    backgroundColor: color.navy,
    paddingVertical: 5,
    borderRadius: 8,
    marginTop: 8,
    fontSize: 13,
    lineHeight: 19,
  },
  feedback: { color: color.navy, paddingVertical: 8, fontSize: 14 },
  actionOption: {
    minHeight: 72,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderBottomWidth: 1,
    borderColor: color.border,
    paddingVertical: 10,
  },
  actionCopy: { flex: 1, gap: 5 },
  optionName: { color: color.text, fontSize: 16, fontWeight: '600' },
  optionHint: { color: color.dim, fontSize: 13 },
  darkNote: { color: color.dim, fontSize: 14, lineHeight: 20 },
  choice: {
    minHeight: 48,
    backgroundColor: color.card,
    borderWidth: 1,
    borderColor: color.border,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 8,
  },
  choiceText: { color: color.gold, fontSize: 14, fontWeight: '600' },
  slipOptions: { flexDirection: 'row', gap: 6 },
  slipChoice: {
    flex: 1,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 8,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: color.border,
  },
  selectedChoice: { borderColor: color.gold },
  slippageInput: {
    minHeight: 48,
    borderWidth: 1,
    borderColor: color.border,
    backgroundColor: color.card,
    borderRadius: 10,
    padding: 10,
    color: color.text,
    fontSize: 16,
  },
  warning: { color: color.gold, fontSize: 14, lineHeight: 20 },
});
