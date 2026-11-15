/**
 * The shared action panel SHELL — one sheet, venue bodies plugged in.
 *
 * DESIGN.md §12/§13: venue sheet = grabber, ground bg, 12 top corners, hairline
 * top border, dim behind, drag/scrim to close; top-down = amount first, THEN
 * body inputs, THEN quote/preview rows, THEN confirm. Validation surfaces
 * vermillion directly above the confirm; confirm is disabled while validation
 * or a submit is pending, and single-fire.
 *
 * The shell knows nothing about perps, prediction markets or LP positions:
 * everything venue-specific arrives via the ActionVenueAdapter (label, accent,
 * swipe label, validation, quote rows, submit) and a venue body rendered into
 * the `renderBody` slot. Execution modules are called by the venue's adapter
 * exactly the way today's screens call them — this shell never signs anything.
 */

import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { DiscoveryBottomSheet, DiscoverySheetCloseButton } from '@/features/discovery/DiscoveryBottomSheet';
import {
  formatActionAmount,
  parseActionAmount,
  type ActionAmountState,
  type ActionQuote,
  type ActionValidation,
  type ActionVenueAdapter,
} from '@/features/markets/action/action.contract';
import { SwipeToConfirm } from '@/features/markets/action/SwipeToConfirm';
import { tokens } from '@/theme/tokens';

export interface ActionPanelSheetProps<TBody, TExtra> {
  visible: boolean;
  onClose: () => void;
  /** Called once after a submit reports `submitted` (venue refresh hook). */
  onSubmitted?: () => void;
  /** Sheet title — the symbol, e.g. 'SOL-PERP' or the market's shortest label. */
  title: string;
  adapter: ActionVenueAdapter<TBody, TExtra>;
  /** Body state the venue owns (side, limit price, TP/SL…), reset on every open. */
  initialBody: TBody;
  /** Screen-provided extras passed through to the adapter. */
  context: TExtra;
  /** Venue body: its own inputs, first control row first (DESIGN.md order). */
  renderBody: (state: { body: TBody; patch: (patch: Partial<TBody>) => void; amount: ActionAmountState }) => ReactNode;
  /** Balance line under the amount, e.g. { label: 'BUYING POWER', text: '$412.50' }. */
  balance: { label: string; text: string | null; loading: boolean } | null;
  /** MAX fill — venue-specific (net of fees, capped by leverage, …). */
  onMax?: () => void;
  /** Quick chips in DESIGN.md §13 order; rendered as `$n` (usd) or `n` (token). */
  quickChips: readonly number[];
  quickChipKind: 'usd' | 'token';
  /**
   * Wallet/wiring gate: when set, the swipe is replaced by a connect CTA with
   * the venue's reason (e.g. Polymarket wallet connect, perps readiness).
   */
  connectRequired: { reason: string; label: string; onPress: () => void } | null;
  testID?: string;
}

/** The dim this app's sheets use behind the panel (matches discovery screens). */
const SHEET_BACKDROP = 'rgba(3,31,44,0.74)';

interface PanelState<TBody> {
  body: TBody;
  amountText: string;
}

/** Quote effect bookkeeping: only the latest request may write state. */
const EMPTY_QUOTE: ActionQuote = { rows: [], loading: false, unavailableReason: null };

export function ActionPanelSheet<TBody extends object, TExtra>({
  visible,
  onClose,
  onSubmitted,
  title,
  adapter,
  initialBody,
  context,
  renderBody,
  balance,
  onMax,
  quickChips,
  quickChipKind,
  connectRequired,
  testID,
}: ActionPanelSheetProps<TBody, TExtra>) {
  const { height } = useWindowDimensions();
  const [state, setState] = useState<PanelState<TBody>>({ body: initialBody, amountText: '' });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quote, setQuote] = useState<ActionQuote>(EMPTY_QUOTE);
  const quoteRequestRef = useRef(0);

  // Sheet opens fresh every time: empty amount, venue body reset, no stale error.
  useEffect(() => {
    if (visible) {
      setState({ body: initialBody, amountText: '' });
      setError(null);
      setSubmitting(false);
      setQuote(EMPTY_QUOTE);
      quoteRequestRef.current += 1;
    }
  }, [visible, initialBody]);

  const amountValue = useMemo(() => parseActionAmount(state.amountText), [state.amountText]);
  const amount: ActionAmountState = useMemo(
    () => ({ amountText: state.amountText, amountValue }),
    [state.amountText, amountValue],
  );
  const panelContext = useMemo(
    () => ({ amount, extra: context }),
    [amount, context],
  );

  const patchBody = useCallback((patch: Partial<TBody>) => {
    setState((prev) => ({ ...prev, body: { ...prev.body, ...patch } }));
  }, []);

  const setAmountText = useCallback((text: string) => {
    setState((prev) => ({ ...prev, amountText: text }));
  }, []);

  // Validation is re-derived on every render — adapters stay pure here.
  const validation: ActionValidation | null = useMemo(
    () => (connectRequired ? null : adapter.validate(state.body, panelContext)),
    [adapter, connectRequired, panelContext, state.body],
  );

  // Live quote: re-run when anything the quote depends on changes.
  useEffect(() => {
    if (!visible) return;
    const request = ++quoteRequestRef.current;
    let cancelled = false;
    const run = async () => {
      try {
        const result = adapter.quote(state.body, panelContext);
        const resolved = result instanceof Promise ? await result : result;
        if (!cancelled && request === quoteRequestRef.current) setQuote(resolved);
      } catch {
        if (!cancelled && request === quoteRequestRef.current)
          setQuote({ rows: [], loading: false, unavailableReason: 'Quote unavailable' });
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [adapter, panelContext, state.body, visible]);

  const blocked = validation != null || submitting || connectRequired != null;

  const handleConfirm = useCallback(async () => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const outcome = await adapter.submit(state.body, panelContext);
      if (outcome.status === 'submitted' && outcome.closeAfter !== false) {
        onSubmitted?.();
        onClose();
        return;
      }
      setSubmitting(false);
      // partial / rejected / closeAfter=false: keep the sheet open so the
      // user sees the message (Meteora recovery, Pacifica TP/SL failures).
      setError(outcome.message);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => null);
    } catch (submitError) {
      setSubmitting(false);
      const message =
        submitError instanceof Error && submitError.message.length > 0
          ? submitError.message
          : 'Submit failed';
      setError(message);
    }
  }, [adapter, onClose, onSubmitted, panelContext, state.body, submitting]);

  const accent = useMemo(
    () => adapter.confirm(state.body, amount).accent,
    [adapter, state.body, amount],
  );
  const confirmLabel = useMemo(
    () => adapter.confirm(state.body, amount).label,
    [adapter, state.body, amount],
  );

  const swipeDisabled = blocked || amountValue == null;

  return (
    <DiscoveryBottomSheet
      visible={visible}
      onClose={submitting ? () => undefined : onClose}
      title={title}
      statusBarTranslucent
      keyboardAvoiding={!connectRequired}
      padBottomToSafeArea
      backdropColor={SHEET_BACKDROP}
      sheetStyle={styles.sheet}
      grabberStyle={styles.grabber}
      titleRowStyle={styles.titleRow}
      titleStyle={styles.title}
      closeButton={
        <DiscoverySheetCloseButton
          onPress={submitting ? () => undefined : onClose}
          style={styles.closeButton}
          iconSize={18}
          iconColor={tokens.colors.textDim}
        />
      }
    >
      <ScrollView
        style={{ maxHeight: height * 0.72 }}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.venueRow}>
          <View style={styles.venuePill}>
            <Text style={styles.venuePillText}>{adapter.label}</Text>
          </View>
        </View>

        {/* §13: amount card first. */}
        <View style={styles.amountCard}>
          <Text style={styles.amountLabel}>{adapter.amountLabel(state.body)}</Text>
          <View style={styles.amountRow}>
            {adapter.amountPrefix(state.body) ? (
              <Text style={styles.amountPrefix}>{adapter.amountPrefix(state.body)}</Text>
            ) : null}
            <TextInput
              style={styles.amountInput}
              value={state.amountText}
              onChangeText={setAmountText}
              keyboardType="decimal-pad"
              placeholder="0"
              placeholderTextColor={tokens.colors.textFaint}
              returnKeyType="done"
              accessibilityLabel={adapter.amountLabel(state.body)}
              testID={testID ? `${testID}-amount` : 'action-panel-amount'}
            />
            {adapter.amountSuffix(state.body) ? (
              <Text style={styles.amountSuffix}>{adapter.amountSuffix(state.body)}</Text>
            ) : null}
          </View>
          {balance ? (
            <View style={styles.balanceRow}>
              <Text style={styles.balanceLabel}>{balance.label}</Text>
              <Text style={[styles.balanceText, balance.loading && styles.balanceLoading]}>
                {balance.loading ? '—' : (balance.text ?? '—')}
              </Text>
              {onMax ? (
                <Pressable
                  hitSlop={8}
                  onPress={() => {
                    onMax();
                    void Haptics.selectionAsync().catch(() => null);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={`Use maximum ${adapter.amountLabel(state.body).toLowerCase()}`}
                  testID={testID ? `${testID}-max` : 'action-panel-max'}
                >
                  <Text style={styles.maxButton}>MAX</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
        </View>

        {quickChips.length > 0 ? (
          <View style={styles.chipRow}>
            {quickChips.map((chip) => (
              <Pressable
                key={chip}
                style={({ pressed }) => [styles.chip, pressed && styles.chipPressed]}
                onPress={() => setAmountText(formatActionAmount(chip))}
                accessibilityRole="button"
                accessibilityLabel={
                  quickChipKind === 'usd' ? `Set amount to $${chip}` : `Set amount to ${chip} ${adapter.amountSuffix(state.body) ?? ''}`.trim()
                }
              >
                <Text style={styles.chipText}>
                  {quickChipKind === 'usd' ? `$${chip}` : `${chip}${adapter.amountSuffix(state.body) ? ` ${adapter.amountSuffix(state.body)}` : ''}`}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}

        {renderBody({ body: state.body, patch: patchBody, amount })}

        <View style={styles.quoteBlock}>
          {quote.unavailableReason ? (
            <Text style={styles.quoteUnavailable}>{quote.unavailableReason}</Text>
          ) : quote.loading && quote.rows.length === 0 ? (
            <View style={styles.quoteLoading}>
              <ActivityIndicator size="small" color={tokens.colors.textDim} />
              <Text style={styles.quoteLoadingText}>Loading…</Text>
            </View>
          ) : (
            quote.rows.map((row) => (
              <View key={row.key} style={styles.quoteRow}>
                <Text style={styles.quoteKey}>{row.key}</Text>
                <Text
                  style={[
                    styles.quoteValue,
                    row.tone === 'dim' && styles.quoteValueDim,
                    row.tone === 'pos' && styles.quoteValuePos,
                    row.tone === 'neg' && styles.quoteValueNeg,
                  ]}
                >
                  {row.value}
                </Text>
              </View>
            ))
          )}
        </View>

        {connectRequired ? (
          <View style={styles.connectBlock}>
            <Text style={styles.connectReason}>{connectRequired.reason}</Text>
            <Pressable
              style={({ pressed }) => [styles.connectButton, pressed && styles.chipPressed]}
              onPress={connectRequired.onPress}
              accessibilityRole="button"
              testID={testID ? `${testID}-connect` : 'action-panel-connect'}
            >
              <Text style={styles.connectButtonText}>{connectRequired.label}</Text>
            </Pressable>
          </View>
        ) : (
          <>
            {validation ? (
              <View style={styles.errorBlock}>
                <Text style={styles.errorText}>{validation.title}</Text>
                {validation.detail ? <Text style={styles.errorDetail}>{validation.detail}</Text> : null}
              </View>
            ) : error ? (
              <View style={styles.errorBlock}>
                <Text style={styles.errorText}>{error}</Text>
              </View>
            ) : null}
            <SwipeToConfirm
              label={submitting ? 'Submitting…' : confirmLabel}
              accent={accent}
              disabled={swipeDisabled || submitting}
              onComplete={() => void handleConfirm()}
              testID={testID ? `${testID}-swipe` : 'action-panel-swipe'}
            />
          </>
        )}
      </ScrollView>
    </DiscoveryBottomSheet>
  );
}

const styles = StyleSheet.create({
  sheet: {
    backgroundColor: tokens.colors.ground,
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: tokens.colors.borderMuted,
    paddingHorizontal: 16,
  },
  grabber: {
    alignSelf: 'center',
    marginTop: 8,
    marginBottom: 4,
    width: 44,
    height: 4,
    borderRadius: 2,
    backgroundColor: tokens.colors.borderMuted,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 2,
    paddingBottom: 8,
    minHeight: 40,
  },
  title: {
    color: tokens.colors.bone,
    fontSize: 16,
    fontWeight: '600',
    letterSpacing: tokens.letterSpacing.tight,
    flexShrink: 1,
  },
  closeButton: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.colors.borderMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  content: {
    paddingBottom: 8,
  },
  venueRow: {
    flexDirection: 'row',
    marginBottom: 10,
  },
  venuePill: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.colors.borderMuted,
    borderRadius: 4,
    paddingVertical: 3,
    paddingHorizontal: 8,
  },
  venuePillText: {
    color: tokens.colors.textDim,
    fontSize: 10,
    letterSpacing: tokens.letterSpacing.mono,
    textTransform: 'uppercase',
  },
  amountCard: {
    backgroundColor: tokens.colors.surface,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.colors.borderMuted,
    padding: 14,
  },
  amountLabel: {
    color: tokens.colors.textDim,
    fontSize: 10,
    letterSpacing: tokens.letterSpacing.mono,
    textTransform: 'uppercase',
    marginBottom: 6,
  },
  amountRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
  },
  amountPrefix: {
    color: tokens.colors.bone,
    fontSize: 34,
    fontWeight: '600',
    paddingBottom: 2,
  },
  amountInput: {
    flex: 1,
    color: tokens.colors.bone,
    fontSize: 34,
    fontWeight: '600',
    padding: 0,
    minWidth: 60,
    minHeight: 44,
  },
  amountSuffix: {
    color: tokens.colors.textDim,
    fontSize: 14,
    paddingBottom: 5,
    marginLeft: 6,
  },
  balanceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 8,
    gap: 6,
  },
  balanceLabel: {
    color: tokens.colors.textFaint,
    fontSize: 10,
    letterSpacing: tokens.letterSpacing.mono,
    textTransform: 'uppercase',
  },
  balanceText: {
    color: tokens.colors.textDim,
    fontSize: 11,
    fontVariant: ['tabular-nums'],
  },
  balanceLoading: {
    color: tokens.colors.textFaint,
  },
  maxButton: {
    color: tokens.colors.accent,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: tokens.letterSpacing.monoWide,
  },
  chipRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 8,
  },
  chip: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 8,
    borderRadius: 4,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.colors.borderMuted,
    backgroundColor: tokens.colors.surface,
  },
  chipPressed: { opacity: 0.7 },
  chipText: {
    color: tokens.colors.textDim,
    fontSize: 12,
    fontVariant: ['tabular-nums'],
  },
  quoteBlock: {
    marginTop: 12,
    gap: 7,
  },
  quoteRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  quoteKey: {
    color: tokens.colors.textDim,
    fontSize: 10,
    letterSpacing: tokens.letterSpacing.mono,
    textTransform: 'uppercase',
  },
  quoteValue: {
    color: tokens.colors.bone,
    fontSize: 12,
    fontVariant: ['tabular-nums'],
  },
  quoteValueDim: { color: tokens.colors.textDim },
  quoteValuePos: { color: tokens.colors.viridian },
  quoteValueNeg: { color: tokens.colors.vermillion },
  quoteUnavailable: {
    color: tokens.colors.textFaint,
    fontSize: 12,
  },
  quoteLoading: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  quoteLoadingText: {
    color: tokens.colors.textFaint,
    fontSize: 12,
  },
  errorBlock: {
    marginTop: 12,
    marginBottom: 2,
    gap: 2,
  },
  errorText: {
    color: tokens.colors.vermillion,
    fontSize: 13,
    fontWeight: '500',
  },
  errorDetail: {
    color: tokens.colors.textDim,
    fontSize: 12,
  },
  connectBlock: {
    marginTop: 12,
    gap: 10,
  },
  connectReason: {
    color: tokens.colors.textDim,
    fontSize: 12,
  },
  connectButton: {
    backgroundColor: tokens.colors.accent,
    borderRadius: 6,
    alignItems: 'center',
    paddingVertical: 12,
  },
  connectButtonText: {
    color: tokens.colors.walletCore,
    fontSize: 13,
    fontWeight: '700',
  },
});
