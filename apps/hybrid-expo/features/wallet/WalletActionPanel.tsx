import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  findNodeHandle,
  Keyboard,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { AssetSwap } from '@/features/swap/components/AssetSwap';
import { SwapTokenPicker } from '@/features/swap/components/SwapTokenPicker';
import { SwapReview } from '@/features/swap/components/SwapReview';
import { formatAtomicAmount, parseUiAmountToAtomic } from '@/features/swap/swap.math';
import { exchangeRate } from '@/features/swap/swap.display';
import { swapTheme as color } from '@/features/swap/swap.theme';
import type { SwapSide } from '@/features/swap/swap.types';
import { useSwapController } from '@/features/swap/useSwapController';
import { useWalletSheet } from '@/features/wallet/WalletSheetProvider';
import { WalletSecondarySheet } from '@/features/wallet/WalletSecondarySheet';
import {
  createReverseGesture,
  WALLET_ACTION_MENU,
  type ReverseGestureController,
  type WalletAction,
} from '@/features/wallet/wallet-action-gesture';

type Surface = 'actions' | 'slippage' | 'balance' | 'review' | null;
const actionIcons = {
  swap: 'currency-exchange',
  send: 'arrow-upward',
  receive: 'arrow-downward',
  transfer: 'swap-horiz',
} as const;

export function WalletActionPanel({
  active,
  surfaceKey,
  onBusyChange,
}: {
  active: boolean;
  surfaceKey: string;
  onBusyChange: (busy: boolean) => void;
}) {
  const c = useSwapController({ mode: 'swap', active });
  const walletSheet = useWalletSheet();
  const [surface, setSurface] = useState<Surface>(null);
  const [comingSoon, setComingSoon] = useState<string | null>(null);
  const payInputRef = useRef<TextInput>(null);
  const actionHeadingRef = useRef<View>(null);
  const restorePayFocus = useRef(false);
  const gesture = useRef<ReverseGestureController | null>(null);
  const previousExternalSurface = useRef(surfaceKey);
  const { phase, invalidatePreparedTrade } = c;
  const latest = useRef({ c, active, surface, walletSheetOpen: walletSheet.isOpen });
  latest.current = { c, active, surface, walletSheetOpen: walletSheet.isOpen };

  const cancelGesture = useCallback(() => gesture.current?.cancel(), []);
  const openActions = useCallback(() => {
    const state = latest.current;
    cancelGesture();
    if (!state.active || state.c.interactionBusy) return;
    restorePayFocus.current = payInputRef.current?.isFocused() ?? false;
    Keyboard.dismiss();
    setSurface('actions');
  }, [cancelGesture]);

  useEffect(() => {
    const recognizer = createReverseGesture({
      isEnabled: () =>
        latest.current.active &&
        latest.current.c.phase === 'compose' &&
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
        setSurface(null);
      }
    }
    previousExternalSurface.current = surfaceKey;
  }, [surfaceKey, walletSheet.isOpen, phase, invalidatePreparedTrade]);
  useEffect(() => {
    onBusyChange(
      c.interactionBusy || c.phase === 'reviewing' || surface !== null || c.phase === 'picker',
    );
  }, [c.interactionBusy, c.phase, surface, onBusyChange]);
  useEffect(() => {
    if (!active) {
      setSurface(null);
      setComingSoon(null);
      restorePayFocus.current = false;
    }
  }, [active]);
  useEffect(() => {
    if (surface === 'review' && c.phase === 'compose') setSurface(null);
  }, [c.phase, surface]);
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
    if (surface === 'review' && c.phase !== 'unknown') c.invalidatePreparedTrade();
    setSurface(null);
    restoreFocus();
  }
  function openSurface(next: Surface) {
    rememberFocus();
    if (c.interactionBusy) return;
    if (next === 'slippage' && !c.invalidatePreparedTrade()) return;
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

  let label = 'Review swap';
  let enabled =
    !!c.amountAtomic &&
    !!c.quote &&
    c.pendingReady &&
    !c.interactionBusy &&
    !c.balanceError &&
    !c.customSlippageError;
  let loading = false;
  let action: 'review' | 'connect' | 'retry' | 'balances' | 'pending' | null = enabled
    ? 'review'
    : null;
  let amountError: string | null = null;
  if (c.amount.trim() !== '') {
    try {
      parseUiAmountToAtomic(c.amount, c.inputToken.decimals);
    } catch (failure) {
      amountError = failure instanceof Error ? failure.message : 'Enter a valid amount.';
    }
  }
  const error =
    c.failure ??
    amountError ??
    c.balanceError ??
    c.balancesError ??
    c.quoteError ??
    c.customSlippageError ??
    c.pendingError;
  if (!c.wallet.connected) {
    label = 'Connect Solana wallet';
    enabled = true;
    action = 'connect';
  } else if (c.phase === 'unknown') {
    label = 'Check pending swap';
    enabled = true;
    action = 'review';
  } else if (c.interactionBusy) {
    label = 'Preparing swap…';
    enabled = false;
    loading = true;
  } else if (c.pendingError) {
    label = 'Retry pending status check';
    enabled = true;
    action = 'pending';
  } else if (!c.pendingReady) {
    label = 'Checking previous swap…';
    enabled = false;
    loading = true;
  } else if (c.phase === 'confirmed') {
    label = 'Swap confirmed · New swap';
    enabled = true;
    action = 'retry';
  } else if (c.phase === 'failed' || c.quoteError) {
    label = 'Refresh quote';
    enabled = true;
    action = 'retry';
  } else if (c.balancesError) {
    label = 'Retry balance';
    enabled = true;
    action = 'balances';
  } else if (c.amountAtomic && !c.balancesResolved) {
    label = 'Checking balance…';
    enabled = false;
    loading = true;
  } else if (c.amountAtomic && !c.quote) {
    label = 'Getting price…';
    enabled = false;
    loading = true;
  }
  if (
    c.isExtremeSlippage &&
    c.extremeConfirmation.trim().toUpperCase() !== 'CONFIRM' &&
    action === 'review' &&
    c.phase !== 'unknown'
  ) {
    label = 'Confirm slippage in settings';
    enabled = false;
    action = null;
  }
  const pickerOpen = c.phase === 'picker';
  const reviewOpen = surface === 'review' && !pickerOpen;
  return (
    <View>
      <View style={styles.heading}>
        <Pressable
          ref={actionHeadingRef}
          onPress={openActions}
          disabled={c.interactionBusy}
          style={styles.actionHeading}
          accessibilityRole="button"
          accessibilityLabel="Swap, choose wallet action"
          accessibilityHint="Opens Swap, Send, Receive and Transfer"
          accessibilityState={{ disabled: c.interactionBusy, expanded: surface === 'actions' }}
        >
          <Text style={styles.actionName}>Swap</Text>
          <MaterialIcons name="expand-more" size={22} color={color.navy} />
        </Pressable>
        <Text style={styles.network}>● Solana</Text>
      </View>
      <AssetSwap
        inputToken={c.inputToken}
        outputToken={c.outputToken}
        amount={c.amount}
        outputAmount={c.outputUi}
        inputUsd={c.inputUsd}
        outputUsd={c.outputUsd}
        inputBalance={c.inputBalanceAtomic}
        busy={c.interactionBusy}
        payInputRef={payInputRef}
        onAmount={(value) => {
          cancelGesture();
          c.setManualAmount(value);
        }}
        onPicker={openPicker}
        onReverse={() => gesture.current?.handleTap()}
        onBalanceShortcuts={() => openSurface('balance')}
        reviewLabel={label}
        reviewEnabled={enabled}
        reviewLoading={loading}
        onReview={() => {
          rememberFocus();
          if (action === 'connect') {
            walletSheet.open('solana');
            return;
          }
          if (action === 'retry') {
            c.retry();
            return;
          }
          if (action === 'balances') {
            void c.retryBalances().catch(() => {});
            return;
          }
          if (action === 'pending') {
            void c.reconcilePending();
            return;
          }
          if (action === 'review') {
            setSurface('review');
            if (c.phase !== 'unknown') void c.prepareReview();
          }
        }}
      />
      {error ? (
        <Text selectable accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
      {comingSoon ? (
        <Text accessibilityLiveRegion="polite" style={styles.feedback}>
          {comingSoon}
        </Text>
      ) : null}
      <View style={styles.quoteStrip}>
        <View style={styles.metric}>
          <Text style={styles.metricLabel}>Exchange rate</Text>
          <Text selectable style={styles.metricValue}>
            {exchangeRate(c.quote, c.inputToken, c.outputToken)}
          </Text>
        </View>
        <Pressable
          style={styles.metric}
          onPress={() => openSurface('slippage')}
          disabled={c.interactionBusy}
          accessibilityRole="button"
          accessibilityLabel="Slippage settings"
          accessibilityState={{ disabled: c.interactionBusy }}
        >
          <Text style={styles.metricLabel}>Slippage</Text>
          <Text style={[styles.metricValue, styles.slippage]}>
            {c.slippageMode === 'auto'
              ? 'Auto'
              : c.slippageBps === undefined
                ? 'Invalid'
                : `${c.slippageBps / 100}%`}{' '}
            ⌄
          </Text>
        </Pressable>
        <View style={styles.metric}>
          <Text style={styles.metricLabel}>Minimum received</Text>
          <Text selectable style={styles.metricValue}>
            {c.quote
              ? `${formatAtomicAmount(c.quote.minimumOutAmountAtomic, c.outputToken.decimals, 8)} ${c.outputToken.symbol}`
              : '—'}
          </Text>
        </View>
      </View>
      <WalletSecondarySheet
        visible={active && (surface !== null || pickerOpen)}
        title={
          pickerOpen
            ? `Choose ${c.pickerSide === 'input' ? 'Pay' : 'Receive'} asset`
            : surface === 'actions'
              ? 'Wallet actions'
              : surface === 'slippage'
                ? 'Slippage settings'
                : surface === 'balance'
                  ? 'Use available balance'
                  : 'Review swap'
        }
        onClose={closeSurface}
        busy={c.interactionBusy && c.phase !== 'unknown'}
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
        {surface === 'balance' ? (
          <>
            <Text style={styles.darkNote}>
              Use a share of your available {c.inputToken.symbol}. SOL keeps the existing 0.005 SOL
              fee reserve.
            </Text>
            {[25, 50, 100].map((percent) => (
              <Pressable
                key={percent}
                style={styles.choice}
                onPress={() => {
                  c.balancePercent(percent);
                  closeSurface();
                }}
                accessibilityRole="button"
                accessibilityLabel={`Use ${percent} percent of available balance`}
              >
                <Text style={styles.choiceText}>{percent === 100 ? 'Max' : `${percent}%`}</Text>
              </Pressable>
            ))}
          </>
        ) : null}
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
                Slippage above 5% applies only to this compose session. Leaving Wallet or changing
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
        {reviewOpen ? <SwapReview controller={c} /> : null}
      </WalletSecondarySheet>
    </View>
  );
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
  network: { color: color.navy, fontSize: 12 },
  quoteStrip: { minHeight: 62, flexDirection: 'row', gap: 8, paddingVertical: 8 },
  metric: { flex: 1, minHeight: 44, justifyContent: 'center', gap: 4 },
  metricLabel: { color: color.navy, fontSize: 11 },
  metricValue: { color: color.navy, fontSize: 12, lineHeight: 17, fontVariant: ['tabular-nums'] },
  slippage: { textDecorationLine: 'underline' },
  error: {
    color: color.text,
    backgroundColor: color.navy,
    padding: 10,
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
