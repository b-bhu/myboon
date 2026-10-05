import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import type { MeteoraStrategy } from '@myboon/shared/meteora';
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Keyboard,
  KeyboardAvoidingView,
  PanResponder,
  Platform,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
  Modal,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TokenIcon } from '@/components/TokenIcon';
import {
  liquidityDistributionWeight,
} from '@/features/meteora/meteora.form';
import {
  type MeteoraPositionTokenMode,
} from '@/features/meteora/meteora.position-range';
import type { MeteoraLiquidityDistributionBar } from '@/features/meteora/meteora.liquidity-distribution';
import { rangeHandleGeometry } from '@/features/meteora/meteora.position-form';
import { rangeDragDelta } from '@/features/meteora/meteora.range-drag';
import { METEORA_COLORS, METEORA_TINTS } from '@/features/meteora/meteora.theme';
import { tokens } from '@/theme/tokens';

export function FormSection({
  title,
  caption,
  action,
  children,
}: {
  title: string;
  caption?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeading}>
        <View style={styles.sectionTitleBlock}>
          <Text style={styles.sectionTitle}>{title}</Text>
          {caption ? <Text style={styles.sectionCaption}>{caption}</Text> : null}
        </View>
        {action}
      </View>
      {children}
    </View>
  );
}

export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  accessibilityLabel,
  disabled = false,
}: {
  value: T;
  options: {
    id: T;
    label: string;
    description?: string;
    icon?: keyof typeof MaterialIcons.glyphMap;
    strategy?: MeteoraStrategy;
  }[];
  onChange: (value: T) => void;
  accessibilityLabel: string;
  disabled?: boolean;
}) {
  return (
    <View
      style={styles.segmented}
      accessibilityRole="radiogroup"
      accessibilityLabel={accessibilityLabel}
    >
      {options.map((option) => {
        const selected = option.id === value;
        return (
          <Pressable
            key={option.id}
            onPress={() => onChange(option.id)}
            disabled={disabled}
            accessibilityRole="radio"
            accessibilityState={{ selected, disabled }}
            accessibilityLabel={option.label}
            accessibilityHint={option.description}
            style={({ pressed }) => [
              styles.segment,
              selected && styles.segmentSelected,
              disabled && styles.disabled,
              pressed && styles.pressed,
            ]}
          >
            {option.strategy ? (
              <StrategyGlyph strategy={option.strategy} selected={selected} />
            ) : option.icon ? (
              <MaterialIcons
                name={option.icon}
                size={17}
                color={selected ? METEORA_COLORS.text : METEORA_COLORS.textDim}
              />
            ) : null}
            <Text style={[styles.segmentText, selected && styles.segmentTextSelected]}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function StrategyGlyph({ strategy, selected }: { strategy: MeteoraStrategy; selected: boolean }) {
  return (
    <View style={styles.strategyGlyph} importantForAccessibility="no-hide-descendants">
      {Array.from({ length: 7 }, (_, index) => {
        const position = index / 6;
        const weight = liquidityDistributionWeight(strategy, position);
        const height = Math.min(14, 4 + Math.round(weight * 10));
        const firstHalf = index < 3;
        return (
          <View
            key={index}
            style={[
              styles.strategyGlyphBar,
              { height },
              selected && firstHalf ? styles.strategyGlyphPrimary : null,
              selected && !firstHalf ? styles.strategyGlyphAccent : null,
              !selected ? styles.strategyGlyphMuted : null,
            ]}
          />
        );
      })}
    </View>
  );
}

export function ChoiceChips<T extends string>({
  value,
  options,
  onChange,
  accessibilityLabel,
}: {
  value: T;
  options: { id: T; label: string; description?: string; disabled?: boolean }[];
  onChange: (value: T) => void;
  accessibilityLabel: string;
}) {
  return (
    <View
      style={styles.chips}
      accessibilityRole="radiogroup"
      accessibilityLabel={accessibilityLabel}
    >
      {options.map((option) => {
        const selected = value === option.id;
        const disabled = !!option.disabled;
        return (
          <Pressable
            key={option.id}
            onPress={() => onChange(option.id)}
            disabled={disabled}
            accessibilityRole="radio"
            accessibilityState={{ selected, disabled }}
            accessibilityLabel={option.label}
            accessibilityHint={option.description}
            style={({ pressed }) => [
              styles.chip,
              selected && styles.chipSelected,
              disabled && styles.disabled,
              pressed && styles.pressed,
            ]}
          >
            <Text style={[
              styles.chipText,
              selected && styles.chipTextSelected,
              disabled && styles.chipTextDisabled,
            ]}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function TokenAmountField({
  symbol,
  iconUrl,
  iconReloadKey,
  value,
  balance,
  error,
  hideErrorMessage,
  onChangeText,
  onBlur,
  onMax,
  secondaryValue,
  calculated,
  estimated = false,
  onHalf,
  venueIconUrl,
  compact = false,
  disabled,
  accent,
}: {
  symbol: string;
  iconUrl: string | null;
  iconReloadKey?: string | number;
  value: string;
  balance?: string | null;
  error?: string | null;
  hideErrorMessage?: boolean;
  onChangeText: (value: string) => void;
  onBlur: () => void;
  onMax?: () => void;
  secondaryValue?: string;
  calculated?: boolean;
  estimated?: boolean;
  onHalf?: () => void;
  venueIconUrl?: string | null;
  compact?: boolean;
  disabled?: boolean;
  accent: string;
}) {
  const hasBalance = balance !== undefined && balance !== null;
  const hasAmountActions = !!onHalf || !!onMax;
  return (
    <View>
      <View style={[
        styles.amountField,
        compact && styles.amountFieldCompact,
        error && styles.fieldError,
        disabled && styles.disabled,
      ]}>
        <View style={styles.tokenIdentity}>
          <TokenIcon
            reloadKey={iconReloadKey}
            identity={{ iconUrl }}
            venueIconUrl={venueIconUrl}
            letter={symbol}
            size={28}
            tint={accent}
          />
          <View style={styles.tokenIdentityCopy}>
            <Text style={styles.tokenSymbol}>{symbol}</Text>
            {hasAmountActions ? <View style={styles.amountActions}>
              {onHalf ? (
                <Pressable
                  onPress={onHalf}
                  disabled={disabled}
                  accessibilityRole="button"
                  accessibilityLabel={`Use half of available ${symbol}`}
                  hitSlop={{ top: 8, bottom: 8 }}
                  style={styles.amountAction}
                >
                  <Text style={styles.maxText}>50%</Text>
                </Pressable>
              ) : null}
              {onMax ? (
                <Pressable
                  onPress={onMax}
                  disabled={disabled}
                  accessibilityRole="button"
                  accessibilityLabel={`Use maximum spendable ${symbol}`}
                  hitSlop={{ top: 8, bottom: 8 }}
                  style={styles.amountAction}
                >
                  <Text style={styles.maxText}>MAX</Text>
                </Pressable>
              ) : null}
            </View> : null}
          </View>
        </View>
        <View style={styles.amountInputWrap}>
          <TextInput
            value={value}
            onChangeText={onChangeText}
            onBlur={onBlur}
            editable={!disabled}
            keyboardType="decimal-pad"
            placeholder="0.00"
            placeholderTextColor={METEORA_COLORS.textFaint}
            accessibilityLabel={`${symbol} amount`}
            accessibilityHint={estimated
              ? `Estimated ${symbol} amount for the selected range and strategy. A live Auto-Fill quote is required before review.`
              : `Enter the amount of ${symbol} to use`}
            accessibilityState={{ disabled: !!disabled }}
            style={[styles.amountInput, error && styles.amountInputError]}
          />
          {secondaryValue || calculated ? (
            <Text style={styles.amountSecondary} numberOfLines={1}>
              {estimated ? 'Estimated · Auto-Fill' : calculated
                ? secondaryValue
                  ? `${secondaryValue} · Auto-filled`
                  : 'Auto-filled'
                : secondaryValue}
            </Text>
          ) : null}
          {hasBalance ? (
            <View style={styles.amountBalance}>
              <MaterialIcons name="account-balance-wallet" size={11} color={METEORA_COLORS.textFaint} />
              <Text
                style={styles.balanceText}
                numberOfLines={1}
                accessibilityLabel={`Available ${symbol} balance: ${balance}`}
              >
                Balance: {balance}
              </Text>
            </View>
          ) : null}
        </View>
      </View>
      {error && !hideErrorMessage ? (
        <Text style={styles.errorText} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

export function AutoFillControl({
  value,
  onChange,
  compact = false,
  disabled = false,
}: {
  value: boolean;
  onChange: (value: boolean) => void;
  compact?: boolean;
  disabled?: boolean;
}) {
  return (
    <View style={[styles.autoFill, compact && styles.autoFillCompact, disabled && styles.disabled]}>
      <View style={[styles.autoFillCopy, compact && styles.autoFillCopyCompact]}>
        <Text style={styles.autoFillTitle} numberOfLines={1}>Auto-Fill</Text>
        {!compact ? <Text style={styles.autoFillCaption}>Calculate the other pool token</Text> : null}
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        disabled={disabled}
        accessibilityLabel="Auto-Fill the other pool token"
        trackColor={{
          false: METEORA_COLORS.border,
          true: METEORA_TINTS.selected,
        }}
        thumbColor={value ? METEORA_COLORS.accent : METEORA_COLORS.textDim}
      />
    </View>
  );
}

export function RangeVisualization({
  bars,
  poolLiquidityBars = [],
  poolLiquidityState,
  minLabel,
  maxLabel,
  currentLabel,
  quoteLabel,
  tokenXSymbol,
  tokenYSymbol,
  tokenXColor = METEORA_COLORS.primary,
  tokenYColor = METEORA_COLORS.accent,
  leftColor,
  rightColor,
  leftTokenSymbol,
  rightTokenSymbol,
  minPercent = 22,
  maxPercent = 78,
  currentPercent = 50,
  dragBinSpan = 68,
  axisMinLabel,
  axisMaxLabel,
  tokenMode = 'both',
  priceInverted = false,
  onAdjustMin,
  onAdjustMax,
  onShiftRange,
  interactive = true,
}: {
  bars: readonly MeteoraLiquidityDistributionBar[];
  /** Real SDK pool-bin liquidity; deliberately separate from deposit bars. */
  poolLiquidityBars?: readonly number[];
  /** Never present a pending/failed SDK read as a zero-liquidity histogram. */
  poolLiquidityState?: 'loading' | 'error';
  minLabel: string;
  maxLabel: string;
  currentLabel: string;
  quoteLabel?: string;
  tokenXSymbol?: string;
  tokenYSymbol?: string;
  tokenXColor?: string;
  tokenYColor?: string;
  leftColor?: string;
  rightColor?: string;
  leftTokenSymbol?: string;
  rightTokenSymbol?: string;
  minPercent?: number;
  maxPercent?: number;
  currentPercent?: number;
  dragBinSpan?: number;
  axisMinLabel?: string;
  axisMaxLabel?: string;
  tokenMode?: MeteoraPositionTokenMode;
  priceInverted?: boolean;
  onAdjustMin?: (deltaBins: number) => number | void;
  onAdjustMax?: (deltaBins: number) => number | void;
  onShiftRange?: (deltaBins: number) => number | void;
  interactive?: boolean;
}) {
  const { minPercent: safeMin, maxPercent: safeMax, currentPercent: safeCurrent }
    = rangeHandleGeometry(minPercent, maxPercent, currentPercent);
  // Do not clamp the real pool marker to an endpoint. A one-sided/far range
  // should show that the active price lies outside its retained viewport.
  const currentInViewport = Number.isFinite(currentPercent) && currentPercent >= 3 && currentPercent <= 97;
  const currentOffRangeSide = currentPercent < 3 ? 'below' : currentPercent > 97 ? 'above' : null;
  const resolvedXColor = priceInverted
    ? leftColor ?? tokenXColor
    : rightColor ?? tokenXColor;
  const resolvedYColor = priceInverted
    ? rightColor ?? tokenYColor
    : leftColor ?? tokenYColor;
  const resolvedLeftColor = priceInverted ? resolvedXColor : resolvedYColor;
  const resolvedRightColor = priceInverted ? resolvedYColor : resolvedXColor;
  const leftToken = priceInverted ? 'x' : 'y';
  const rightToken = priceInverted ? 'y' : 'x';
  const leftFunded = tokenMode === 'both'
    || tokenMode === 'x_only' && leftToken === 'x'
    || tokenMode === 'y_only' && leftToken === 'y';
  const rightFunded = tokenMode === 'both'
    || tokenMode === 'x_only' && rightToken === 'x'
    || tokenMode === 'y_only' && rightToken === 'y';
  const interactiveMin = interactive && !!onAdjustMin;
  const interactiveMax = interactive && !!onAdjustMax;
  const interactiveCenter = interactive && !!onShiftRange;
  const hasInteractiveHandle = interactiveMin || interactiveMax;
  const bubbleShift = safeCurrent < 20 ? 48 : safeCurrent > 80 ? -48 : 0;
  const [trackWidth, setTrackWidth] = useState(0);

  return (
    <View
      style={styles.rangeCard}
      testID="meteora-range-selector"
      accessibilityLabel={
        `${hasInteractiveHandle ? 'Price range' : 'Fixed price range'}. `
        + `${tokenMode === 'x_only' ? `${tokenXSymbol ?? 'Token X'}-only deposit. ` : ''}`
        + `${tokenMode === 'y_only' ? `${tokenYSymbol ?? 'Token Y'}-only deposit. ` : ''}`
        + `Minimum ${minLabel}. Current ${currentLabel}. Maximum ${maxLabel}.`
      }
    >
      <View style={styles.rangeLegend}>
        <View style={[styles.rangeLegendItem, !leftFunded && styles.rangeLegendUnused]}>
          <View style={[styles.rangeLegendDot, { backgroundColor: resolvedLeftColor }, !leftFunded && styles.rangeLegendDotUnused]} />
          <Text style={[styles.rangeLegendText, !leftFunded && styles.rangeLegendTextUnused]} numberOfLines={1}>
            {leftTokenSymbol ?? (priceInverted ? tokenXSymbol : tokenYSymbol) ?? (priceInverted ? 'Token X' : 'Token Y')}
          </Text>
        </View>
        <View style={[styles.rangeLegendItem, !rightFunded && styles.rangeLegendUnused]}>
          <Text style={[styles.rangeLegendText, !rightFunded && styles.rangeLegendTextUnused]} numberOfLines={1}>
            {rightTokenSymbol ?? (priceInverted ? tokenYSymbol : tokenXSymbol) ?? (priceInverted ? 'Token Y' : 'Token X')}
          </Text>
          <View style={[styles.rangeLegendDot, { backgroundColor: resolvedRightColor }, !rightFunded && styles.rangeLegendDotUnused]} />
        </View>
      </View>
      <View style={styles.combinedChart} importantForAccessibility="no-hide-descendants">
        {bars.map((bar, index) => {
          const allocated = bar.height > 0;
          return (
            <View
              key={index}
              testID={`meteora-liquidity-bar-${index}`}
              style={[
                styles.histogramBar,
                {
                  height: allocated ? Math.max(1, bar.height * 48) : 2,
                },
                !allocated && styles.histogramBarMuted,
              ]}
            >
              {allocated && bar.xFraction > 0 ? (
                <View style={{ height: `${bar.xFraction * 100}%`, backgroundColor: resolvedXColor }} />
              ) : null}
              {allocated && bar.yFraction > 0 ? (
                <View style={{ height: `${bar.yFraction * 100}%`, backgroundColor: resolvedYColor }} />
              ) : null}
            </View>
          );
        })}
        {currentInViewport ? (
          <>
            <View style={[styles.allocationMarker, { left: `${currentPercent}%` }]} />
            <View
              style={[
                styles.allocationPriceBubble,
                { left: `${currentPercent}%` },
                bubbleShift !== 0 && { transform: [{ translateX: bubbleShift }] },
              ]}
            >
              <Text style={styles.allocationPriceTitle}>Pool Price</Text>
              <Text style={styles.allocationPriceValue} numberOfLines={1}>
                {currentLabel}{quoteLabel ? ` ${quoteLabel}` : ''}
              </Text>
            </View>
          </>
        ) : (
          <Text style={styles.offRangePrice} testID="meteora-off-range-price">
            Pool price {currentLabel} is {currentOffRangeSide} this range
          </Text>
        )}
      </View>
      <View
        style={styles.allocationTrack}
        testID="meteora-allocation-track"
        onLayout={({ nativeEvent }) => {
          setTrackWidth(nativeEvent.layout.width);
        }}
      >
        {interactiveCenter ? (
          <AdjustableHandle
            label="Move liquidity range"
            testID="meteora-center-handle"
            value={`${minLabel} to ${maxLabel}`}
            percent={(safeMin + safeMax) / 2}
            trackWidth={trackWidth}
            onAdjust={onShiftRange!}
            dragBinSpan={dragBinSpan}
            center
          />
        ) : null}
      </View>
      <View style={styles.poolLiquidityChart} importantForAccessibility="no-hide-descendants">
        {poolLiquidityState ? (
          <Text style={styles.poolLiquidityPlaceholder} testID="meteora-pool-liquidity-status">
            {poolLiquidityState === 'loading' ? 'Loading real pool liquidity…' : 'Real pool liquidity unavailable'}
          </Text>
        ) : bars.map((_, index) => {
          const height = poolLiquidityBars[index] ?? 0;
          return (
            <View
              key={`pool-${index}`}
              testID={`meteora-pool-liquidity-bar-${index}`}
              style={[styles.poolLiquidityBar, { height: height > 0 ? Math.max(1, height * 34) : 1 }]}
            />
          );
        })}
        {!poolLiquidityState && currentInViewport ? <View style={[styles.poolLiquidityMarker, { left: `${currentPercent}%` }]} /> : null}
      </View>
      <View
        style={styles.rangeTrack}
        testID="meteora-pool-range-track"
        onLayout={({ nativeEvent }) => {
          setTrackWidth(nativeEvent.layout.width);
        }}
      >
        <View
          style={[
            styles.rangeSelected,
            { left: `${safeMin}%`, right: `${100 - safeMax}%` },
          ]}
        />
        {hasInteractiveHandle ? (
          <>
            {interactiveMin ? (
              <AdjustableHandle
                label="Minimum price"
                testID="meteora-min-handle"
                value={minLabel}
                percent={safeMin}
                trackWidth={trackWidth}
                onAdjust={onAdjustMin!}
                dragBinSpan={dragBinSpan}
              />
            ) : null}
            {interactiveMax ? (
              <AdjustableHandle
                label="Maximum price"
                testID="meteora-max-handle"
                value={maxLabel}
                percent={safeMax}
                trackWidth={trackWidth}
                onAdjust={onAdjustMax!}
                dragBinSpan={dragBinSpan}
              />
            ) : null}
          </>
        ) : (
          <>
            <View style={[styles.handleTouch, styles.handleTouchStatic, { left: `${safeMin}%` }]}>
              <View style={styles.handleStem} />
              <View style={styles.handleKnobStatic} />
            </View>
            <View style={[styles.handleTouch, styles.handleTouchStatic, { left: `${safeMax}%` }]}>
              <View style={styles.handleStem} />
              <View style={styles.handleKnobStatic} />
            </View>
          </>
        )}
      </View>
      <View style={styles.allocationAxis}>
        <Text style={styles.rangeAxisText}>{axisMinLabel ?? minLabel}</Text>
        {currentInViewport && currentPercent > 15 && currentPercent < 85 ? (
          <Text style={[styles.rangeAxisText, styles.rangeAxisCenter, { left: `${currentPercent}%` }]}>{currentLabel}</Text>
        ) : null}
        <Text style={[styles.rangeAxisText, styles.rangeRight]}>{axisMaxLabel ?? maxLabel}</Text>
      </View>
      <Text style={styles.rangeInstruction}>
        {hasInteractiveHandle
          ? `${tokenMode === 'x_only' ? `${tokenXSymbol ?? 'Token X'}-only deposit. ` : ''}${tokenMode === 'y_only' ? `${tokenYSymbol ?? 'Token Y'}-only deposit. ` : ''}Drag the center to move the range, or either end to resize it.`
          : 'Range is fixed at the current position.'}
      </Text>
    </View>
  );
}

function AdjustableHandle({
  label,
  testID,
  value,
  percent,
  trackWidth,
  onAdjust,
  dragBinSpan,
  center = false,
}: {
  label: string;
  testID: string;
  value: string;
  percent: number;
  trackWidth: number;
  onAdjust: (deltaBins: number) => number | void;
  dragBinSpan?: number;
  center?: boolean;
}) {
  const previousStep = useRef(0);
  const pointerStartX = useRef<number | null>(null);
  const onAdjustRef = useRef(onAdjust);
  onAdjustRef.current = onAdjust;
  const currentMetricsRef = useRef({ trackWidth, binSpan: dragBinSpan ?? 68 });
  currentMetricsRef.current = { trackWidth, binSpan: dragBinSpan ?? 68 };
  const dragMetricsRef = useRef(currentMetricsRef.current);
  const beginDrag = useCallback(() => {
    previousStep.current = 0;
    dragMetricsRef.current = currentMetricsRef.current;
  }, []);
  const applyHorizontalDrag = useCallback((horizontalPixels: number) => {
    const metrics = dragMetricsRef.current;
    const delta = rangeDragDelta(horizontalPixels, metrics.trackWidth, metrics.binSpan, previousStep.current);
    if (delta !== 0) {
      const accepted = onAdjustRef.current(delta);
      previousStep.current += accepted ?? delta;
    }
  }, []);
  const panResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: (_, gesture) => (
      Math.abs(gesture.dx) > 4 && Math.abs(gesture.dx) > Math.abs(gesture.dy)
    ),
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: () => {
      beginDrag();
    },
    onPanResponderMove: (_, gesture) => {
      applyHorizontalDrag(gesture.dx);
    },
    onPanResponderRelease: () => {
      previousStep.current = 0;
    },
    onPanResponderTerminate: () => {
      previousStep.current = 0;
    },
  }), [applyHorizontalDrag, beginDrag]);

  return (
    <View
      {...(Platform.OS === 'web' ? {} : panResponder.panHandlers)}
      onPointerDown={Platform.OS === 'web' ? (event) => {
        pointerStartX.current = event.nativeEvent.pageX;
        beginDrag();
        const target = event.currentTarget as unknown as {
          setPointerCapture?: (pointerId: number) => void;
        };
        target.setPointerCapture?.(event.nativeEvent.pointerId);
      } : undefined}
      onPointerMove={Platform.OS === 'web' ? (event) => {
        if (pointerStartX.current === null) return;
        applyHorizontalDrag(event.nativeEvent.pageX - pointerStartX.current);
      } : undefined}
      onPointerUp={Platform.OS === 'web' ? (event) => {
        pointerStartX.current = null;
        previousStep.current = 0;
        const target = event.currentTarget as unknown as {
          releasePointerCapture?: (pointerId: number) => void;
        };
        target.releasePointerCapture?.(event.nativeEvent.pointerId);
      } : undefined}
      onPointerCancel={Platform.OS === 'web' ? () => {
        pointerStartX.current = null;
        previousStep.current = 0;
      } : undefined}
      testID={testID}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={label}
      accessibilityValue={{ text: value }}
      accessibilityActions={[
        { name: 'decrement', label: `Decrease ${label.toLowerCase()}` },
        { name: 'increment', label: `Increase ${label.toLowerCase()}` },
      ]}
      onAccessibilityAction={({ nativeEvent }) => {
        if (nativeEvent.actionName === 'decrement' || nativeEvent.actionName === 'increment') {
          onAdjustRef.current(nativeEvent.actionName === 'increment' ? 1 : -1);
        }
      }}
      style={[styles.handleTouch, center && styles.centerHandleTouch, { left: `${percent}%` }]}
    >
      {!center ? <View style={styles.handleStem} /> : null}
      <View style={[styles.handleKnob, center && styles.centerHandleKnob]}>
        <View style={[styles.handleGrip, center && styles.centerHandleGrip]} />
      </View>
    </View>
  );
}

export function PriceField({
  label,
  value,
  displayValue,
  suffix,
  error,
  hideErrorMessage = false,
  compact = false,
  disabled = false,
  onChangeText,
  onBlur,
  onStep,
}: {
  label: string;
  value: string;
  /** Compact label only; the editor keeps the unrounded value. */
  displayValue?: string;
  suffix: string;
  error?: string | null;
  hideErrorMessage?: boolean;
  compact?: boolean;
  disabled?: boolean;
  onChangeText: (value: string) => void;
  onBlur: () => void;
  onStep: (direction: 'decrement' | 'increment') => void;
}) {
  const insets = useSafeAreaInsets();
  const [editorOpen, setEditorOpen] = useState(false);
  const finishEditing = useCallback(() => {
    Keyboard.dismiss();
    setEditorOpen(false);
    onBlur();
  }, [onBlur]);

  if (compact) {
    return (
      <View style={[styles.priceFieldWrap, styles.priceFieldWrapCompact, disabled && styles.disabled]}>
        <Pressable
          onPress={() => setEditorOpen(true)}
          disabled={disabled}
          accessibilityRole="button"
          accessibilityLabel={`Edit ${label}`}
          accessibilityState={{ disabled }}
          style={[styles.compactPriceCell, error && styles.fieldError]}
        >
          <Text style={styles.inputLabel}>{label}</Text>
          <Text style={[styles.compactPriceValue, error && styles.amountInputError]} numberOfLines={1}>
            {displayValue ?? (value || '0.00')}
          </Text>
          <Text style={styles.compactPriceSuffix}>{suffix}</Text>
          <MaterialIcons
            name="edit"
            size={15}
            color={METEORA_COLORS.textDim}
            style={styles.compactPriceEditIcon}
          />
        </Pressable>
        {error && !hideErrorMessage ? <Text style={styles.errorText} accessibilityRole="alert">{error}</Text> : null}
        <Modal
          visible={editorOpen}
          transparent
          animationType="slide"
          onRequestClose={finishEditing}
          accessibilityViewIsModal
        >
          <KeyboardAvoidingView
            style={styles.editorKeyboardAvoiding}
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          >
            <View style={styles.editorOverlay}>
              <View style={[styles.editorSheet, { paddingBottom: Math.max(insets.bottom, 16) }]}>
              <View style={styles.editorHeader}>
                <Text style={styles.editorTitle}>{label}</Text>
                <Pressable
                  onPress={finishEditing}
                  accessibilityRole="button"
                  accessibilityLabel={`Close ${label} editor`}
                  style={styles.editorClose}
                >
                  <MaterialIcons name="close" size={20} color={METEORA_COLORS.textDim} />
                </Pressable>
              </View>
              <TextInput
                value={value}
                onChangeText={onChangeText}
                onBlur={onBlur}
                editable={!disabled}
                keyboardType="decimal-pad"
                autoFocus
                placeholder="0.00"
                placeholderTextColor={METEORA_COLORS.textFaint}
                accessibilityLabel={`${label} exact price`}
                style={[styles.editorInput, error && styles.amountInputError]}
              />
              <Text style={styles.editorSuffix}>{suffix}</Text>
              <View style={styles.editorSteps}>
                <Pressable
                  onPress={() => onStep('decrement')}
                  disabled={disabled}
                  accessibilityRole="button"
                  accessibilityLabel={`Decrease ${label}`}
                  style={styles.editorStepButton}
                >
                  <MaterialIcons name="remove" size={21} color={METEORA_COLORS.text} />
                </Pressable>
                <Pressable
                  onPress={() => onStep('increment')}
                  disabled={disabled}
                  accessibilityRole="button"
                  accessibilityLabel={`Increase ${label}`}
                  style={styles.editorStepButton}
                >
                  <MaterialIcons name="add" size={21} color={METEORA_COLORS.text} />
                </Pressable>
              </View>
              <Pressable
                onPress={finishEditing}
                accessibilityRole="button"
                accessibilityLabel={`Done editing ${label}`}
                style={styles.editorDone}
              >
                <Text style={styles.editorDoneText}>Done</Text>
              </Pressable>
              </View>
            </View>
          </KeyboardAvoidingView>
        </Modal>
      </View>
    );
  }

  return (
    <View style={[styles.priceFieldWrap, disabled && styles.disabled]}>
      <Text style={styles.inputLabel}>{label}</Text>
      <View style={[styles.priceField, error && styles.fieldError]}>
        <TextInput
          value={value}
          onChangeText={onChangeText}
          onBlur={onBlur}
          editable={!disabled}
          keyboardType="decimal-pad"
          placeholder="0.00"
          placeholderTextColor={METEORA_COLORS.textFaint}
          accessibilityLabel={label}
          style={styles.priceInput}
        />
        <Text style={styles.priceSuffix}>{suffix}</Text>
        <View style={styles.stepper}>
          <Pressable
            onPress={() => onStep('increment')}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityLabel={`Increase ${label.toLowerCase()} by one bin`}
            style={styles.stepButton}
          >
            <MaterialIcons name="add" size={17} color={METEORA_COLORS.textDim} />
          </Pressable>
          <View style={styles.stepDivider} />
          <Pressable
            onPress={() => onStep('decrement')}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityLabel={`Decrease ${label.toLowerCase()} by one bin`}
            style={styles.stepButton}
          >
            <MaterialIcons name="remove" size={17} color={METEORA_COLORS.textDim} />
          </Pressable>
        </View>
      </View>
      {error && !hideErrorMessage ? <Text style={styles.errorText} accessibilityRole="alert">{error}</Text> : null}
    </View>
  );
}

export function InlineNotice({
  tone,
  title,
  message,
}: {
  tone: 'info' | 'warning' | 'error' | 'success' | 'pending';
  title: string;
  message: string;
}) {
  const icon = tone === 'success'
    ? 'check-circle'
    : tone === 'error'
      ? 'error'
      : tone === 'warning'
        ? 'warning'
        : tone === 'pending'
          ? 'schedule'
          : 'info';
  return (
    <View
      accessibilityRole={tone === 'error' ? 'alert' : undefined}
      accessibilityLiveRegion={tone === 'error' ? 'assertive' : 'polite'}
      style={[
        styles.notice,
        tone === 'error' && styles.noticeError,
        tone === 'warning' && styles.noticeWarning,
        tone === 'success' && styles.noticeSuccess,
        tone === 'pending' && styles.noticePending,
      ]}
    >
      <MaterialIcons
        name={icon}
        size={18}
        color={
          tone === 'error'
            ? METEORA_COLORS.negative
            : tone === 'warning'
              ? METEORA_COLORS.warning
              : tone === 'success'
                ? METEORA_COLORS.positive
                : METEORA_COLORS.accent
        }
      />
      <View style={styles.noticeCopy}>
        <Text style={styles.noticeTitle}>{title}</Text>
        <Text style={styles.noticeMessage}>{message}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    gap: 8,
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: METEORA_COLORS.border,
  },
  sectionHeading: {
    minHeight: 28,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  sectionTitleBlock: {
    flex: 1,
    gap: 3,
  },
  sectionTitle: {
    color: METEORA_COLORS.text,
    fontSize: 14,
    lineHeight: 19,
    fontWeight: '800',
  },
  sectionCaption: {
    color: METEORA_COLORS.textDim,
    fontSize: 12,
    lineHeight: 17,
  },
  segmented: {
    minHeight: 44,
    flexDirection: 'row',
    padding: 4,
    borderRadius: tokens.radius.md,
    backgroundColor: METEORA_COLORS.surfaceQuiet,
  },
  segment: {
    minHeight: 36,
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderRadius: tokens.radius.md,
    paddingHorizontal: 7,
  },
  segmentSelected: {
    backgroundColor: METEORA_COLORS.surfaceLift,
    borderWidth: 1,
    borderColor: METEORA_TINTS.selectedBorder,
  },
  segmentText: {
    color: METEORA_COLORS.textDim,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '700',
  },
  segmentTextSelected: {
    color: METEORA_COLORS.text,
  },
  strategyGlyph: {
    height: 14,
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 1,
  },
  strategyGlyphBar: {
    width: 2,
    minHeight: 5,
    borderRadius: 1,
  },
  strategyGlyphPrimary: {
    backgroundColor: METEORA_COLORS.primary,
  },
  strategyGlyphAccent: {
    backgroundColor: METEORA_COLORS.accent,
  },
  strategyGlyphMuted: {
    backgroundColor: METEORA_COLORS.textFaint,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  chip: {
    minHeight: 44,
    minWidth: 70,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: METEORA_COLORS.border,
    backgroundColor: METEORA_COLORS.surface,
  },
  chipSelected: {
    borderColor: METEORA_COLORS.primary,
    backgroundColor: METEORA_TINTS.selected,
  },
  chipText: {
    color: METEORA_COLORS.textDim,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '700',
  },
  chipTextSelected: {
    color: METEORA_COLORS.text,
  },
  chipTextDisabled: {
    color: METEORA_COLORS.textFaint,
  },
  amountField: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: tokens.radius.md,
    borderWidth: 1,
    borderColor: METEORA_COLORS.border,
    backgroundColor: METEORA_COLORS.surfaceLift,
  },
  amountFieldCompact: {
    minHeight: 76,
    paddingVertical: 8,
  },
  tokenIdentity: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  tokenIdentityCopy: {
    minWidth: 0,
    flex: 1,
    gap: 1,
  },
  tokenSymbol: {
    color: METEORA_COLORS.text,
    fontSize: 15,
    lineHeight: 19,
    fontWeight: '800',
  },
  balanceText: {
    flexShrink: 1,
    color: METEORA_COLORS.textFaint,
    fontFamily: 'monospace',
    fontSize: 10,
    lineHeight: 14,
  },
  amountInputWrap: {
    flex: 1,
    alignItems: 'flex-end',
    justifyContent: 'center',
    minWidth: 90,
  },
  amountInput: {
    width: '100%',
    minHeight: 26,
    paddingVertical: 0,
    color: METEORA_COLORS.text,
    fontFamily: 'monospace',
    fontSize: 16,
    lineHeight: 21,
    fontWeight: '700',
    textAlign: 'right',
  },
  amountInputError: {
    color: METEORA_COLORS.negative,
  },
  amountSecondary: {
    maxWidth: '100%',
    color: METEORA_COLORS.textDim,
    fontFamily: 'monospace',
    fontSize: 9,
    lineHeight: 13,
    textAlign: 'right',
  },
  amountBalance: {
    maxWidth: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 4,
    marginTop: 4,
  },
  amountActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginTop: 1,
  },
  amountAction: {
    minHeight: 28,
    minWidth: 44,
    justifyContent: 'center',
  },
  maxText: {
    color: METEORA_COLORS.accent,
    fontSize: 10,
    lineHeight: 13,
    fontWeight: '900',
    letterSpacing: 0.8,
  },
  autoFill: {
    minHeight: 50,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingHorizontal: 2,
  },
  autoFillCompact: {
    minHeight: 32,
    flexDirection: 'row-reverse',
    justifyContent: 'flex-start',
    gap: 7,
    flexShrink: 0,
  },
  autoFillCopy: {
    flex: 1,
  },
  autoFillCopyCompact: {
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: 'auto',
    minWidth: 54,
  },
  autoFillTitle: {
    color: METEORA_COLORS.text,
    fontSize: 13,
    lineHeight: 17,
    fontWeight: '700',
  },
  autoFillCaption: {
    color: METEORA_COLORS.textDim,
    fontSize: 11,
    lineHeight: 16,
  },
  rangeCard: {
    paddingTop: 2,
    paddingBottom: 2,
    overflow: 'visible',
  },
  rangeLegend: {
    minHeight: 20,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  rangeLegendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    maxWidth: '48%',
    flexShrink: 1,
  },
  rangeLegendDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  rangeLegendText: {
    color: METEORA_COLORS.textDim,
    fontSize: 11,
    lineHeight: 15,
    fontWeight: '700',
    flexShrink: 1,
  },
  rangeLegendUnused: {
    opacity: 0.52,
  },
  rangeLegendDotUnused: {
    opacity: 0.45,
  },
  rangeLegendTextUnused: {
    color: METEORA_COLORS.textFaint,
  },
  combinedChart: {
    height: 48,
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 2,
    position: 'relative',
  },
  allocationTrack: {
    height: 24,
    justifyContent: 'center',
  },
  poolLiquidityChart: {
    height: 38,
    marginTop: 8,
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 1,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: METEORA_COLORS.border,
    paddingTop: 4,
    position: 'relative',
  },
  poolLiquidityBar: {
    flex: 1,
    minWidth: 1,
    borderTopLeftRadius: 1,
    borderTopRightRadius: 1,
    backgroundColor: METEORA_COLORS.textDim,
    opacity: 0.5,
  },
  poolLiquidityMarker: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 1,
    backgroundColor: METEORA_COLORS.text,
  },
  poolLiquidityPlaceholder: {
    position: 'absolute',
    top: 11,
    left: 8,
    right: 8,
    color: METEORA_COLORS.textDim,
    fontSize: 10,
    lineHeight: 14,
    textAlign: 'center',
  },
  allocationMarker: {
    position: 'absolute',
    top: 29,
    bottom: 7,
    width: 1,
    marginLeft: -0.5,
    borderLeftWidth: 1,
    borderLeftColor: METEORA_COLORS.text,
    borderStyle: 'dashed',
    opacity: 0.8,
  },
  allocationPriceBubble: {
    position: 'absolute',
    top: 0,
    width: 96,
    marginLeft: -48,
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 5,
    alignItems: 'center',
    backgroundColor: METEORA_COLORS.surfaceLift,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: METEORA_TINTS.selectedBorder,
  },
  allocationPriceTitle: {
    color: METEORA_COLORS.textDim,
    fontSize: 8,
    lineHeight: 10,
    fontWeight: '800',
  },
  offRangePrice: {
    position: 'absolute',
    left: 10,
    right: 10,
    top: 8,
    color: METEORA_COLORS.textDim,
    fontSize: 10,
    lineHeight: 14,
    textAlign: 'center',
  },
  allocationPriceValue: {
    maxWidth: 84,
    color: METEORA_COLORS.accent,
    fontFamily: 'monospace',
    fontSize: 8,
    lineHeight: 11,
    fontWeight: '900',
    textAlign: 'center',
  },
  allocationAxis: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 8,
    marginTop: 1,
    marginBottom: 2,
  },
  rangeAxisText: {
    flex: 1,
    color: METEORA_COLORS.textFaint,
    fontFamily: 'monospace',
    fontSize: 9,
    lineHeight: 12,
  },
  rangeAxisCenter: {
    position: 'absolute',
    width: 80,
    marginLeft: -40,
    textAlign: 'center',
  },
  histogramBar: {
    flex: 1,
    minWidth: 2,
    overflow: 'hidden',
    borderTopLeftRadius: 2,
    borderTopRightRadius: 2,
  },
  histogramBarMuted: {
    backgroundColor: METEORA_COLORS.border,
  },
  rangeTrack: {
    height: 24,
    marginTop: -12,
    justifyContent: 'center',
  },
  rangeSelected: {
    position: 'absolute',
    height: 4,
    borderRadius: 2,
    backgroundColor: METEORA_COLORS.accent,
  },
  handleTouch: {
    position: 'absolute',
    top: -10,
    width: 44,
    height: 44,
    marginLeft: -22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  handleStem: {
    position: 'absolute',
    top: 7,
    bottom: 7,
    width: 2,
    backgroundColor: METEORA_COLORS.accent,
  },
  handleKnob: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: METEORA_COLORS.accent,
    backgroundColor: METEORA_COLORS.accent,
  },
  handleGrip: {
    width: 2,
    height: 8,
    borderRadius: 1,
    backgroundColor: METEORA_COLORS.surfaceQuiet,
    opacity: 0.75,
  },
  centerHandleKnob: {
    width: 24,
    height: 14,
    borderRadius: 5,
    borderWidth: 1,
    borderColor: METEORA_COLORS.text,
    backgroundColor: METEORA_COLORS.primary,
  },
  centerHandleTouch: {
    zIndex: 3,
  },
  centerHandleGrip: {
    width: 8,
    height: 6,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderColor: METEORA_COLORS.text,
    backgroundColor: 'transparent',
  },
  handleTouchStatic: {
    width: 16,
    marginLeft: -8,
  },
  handleKnobStatic: {
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: METEORA_COLORS.accent,
    backgroundColor: METEORA_COLORS.accent,
    opacity: 0.85,
  },
  rangeRight: {
    textAlign: 'right',
  },
  rangeInstruction: {
    marginTop: 4,
    color: METEORA_COLORS.textFaint,
    fontSize: 10,
    lineHeight: 14,
    textAlign: 'center',
  },
  priceFieldWrap: {
    flex: 1,
    gap: 6,
  },
  priceFieldWrapCompact: {
    gap: 2,
  },
  compactPriceCell: {
    position: 'relative',
    minHeight: 60,
    justifyContent: 'center',
    paddingVertical: 4,
    paddingLeft: 8,
    paddingRight: 30,
    borderRadius: tokens.radius.sm,
    backgroundColor: METEORA_COLORS.surfaceLift,
  },
  compactPriceEditIcon: {
    position: 'absolute',
    top: 8,
    right: 8,
  },
  compactPriceValue: {
    color: METEORA_COLORS.text,
    fontFamily: 'monospace',
    fontSize: 16,
    lineHeight: 21,
    fontWeight: '700',
  },
  compactPriceSuffix: {
    color: METEORA_COLORS.textDim,
    fontFamily: 'monospace',
    fontSize: 10,
    lineHeight: 13,
  },
  editorOverlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0, 0, 0, 0.46)',
  },
  editorKeyboardAvoiding: {
    flex: 1,
  },
  editorSheet: {
    paddingHorizontal: 18,
    paddingTop: 16,
    borderTopLeftRadius: tokens.radius.md,
    borderTopRightRadius: tokens.radius.md,
    backgroundColor: METEORA_COLORS.surfaceRaised,
  },
  editorHeader: {
    minHeight: 36,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  editorTitle: {
    color: METEORA_COLORS.text,
    fontSize: 16,
    lineHeight: 21,
    fontWeight: '800',
  },
  editorClose: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  editorInput: {
    minHeight: 54,
    paddingHorizontal: 12,
    color: METEORA_COLORS.text,
    fontFamily: 'monospace',
    fontSize: 22,
    lineHeight: 28,
    fontWeight: '700',
    borderWidth: 1,
    borderColor: METEORA_COLORS.border,
    borderRadius: tokens.radius.md,
    backgroundColor: METEORA_COLORS.surfaceLift,
  },
  editorSuffix: {
    marginTop: 6,
    color: METEORA_COLORS.textDim,
    fontFamily: 'monospace',
    fontSize: 11,
    lineHeight: 15,
  },
  editorSteps: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 14,
  },
  editorStepButton: {
    flex: 1,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: tokens.radius.md,
    backgroundColor: METEORA_COLORS.surfaceLift,
  },
  editorDone: {
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 14,
    borderRadius: tokens.radius.md,
    backgroundColor: METEORA_COLORS.accent,
  },
  editorDoneText: {
    color: METEORA_COLORS.onAccent,
    fontSize: 14,
    lineHeight: 18,
    fontWeight: '900',
  },
  inputLabel: {
    color: METEORA_COLORS.textDim,
    fontSize: 11,
    lineHeight: 15,
    fontWeight: '700',
  },
  priceField: {
    minHeight: 54,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: METEORA_COLORS.border,
    borderRadius: tokens.radius.md,
    backgroundColor: METEORA_COLORS.surfaceLift,
    overflow: 'hidden',
  },
  priceInput: {
    flex: 1,
    minWidth: 0,
    minHeight: 52,
    paddingHorizontal: 11,
    paddingVertical: 8,
    color: METEORA_COLORS.text,
    fontFamily: 'monospace',
    fontSize: 14,
    lineHeight: 18,
  },
  priceSuffix: {
    minWidth: 48,
    paddingHorizontal: 7,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: METEORA_COLORS.border,
    color: METEORA_COLORS.textFaint,
    fontSize: 14,
    lineHeight: 18,
    textAlign: 'center',
  },
  stepper: {
    width: 44,
    alignSelf: 'stretch',
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: METEORA_COLORS.border,
  },
  stepButton: {
    minHeight: 26,
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: METEORA_COLORS.border,
  },
  notice: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    padding: 12,
    borderRadius: tokens.radius.md,
    borderWidth: 1,
    borderColor: METEORA_TINTS.infoBorder,
    backgroundColor: METEORA_TINTS.info,
  },
  noticeError: {
    borderColor: METEORA_TINTS.negativeBorder,
    backgroundColor: METEORA_TINTS.negative,
  },
  noticeWarning: {
    borderColor: METEORA_TINTS.warningBorder,
    backgroundColor: METEORA_TINTS.warning,
  },
  noticeSuccess: {
    borderColor: METEORA_TINTS.positiveBorder,
    backgroundColor: METEORA_TINTS.positive,
  },
  noticePending: {
    borderColor: METEORA_TINTS.infoBorder,
    backgroundColor: METEORA_TINTS.info,
  },
  noticeCopy: {
    flex: 1,
    gap: 2,
  },
  noticeTitle: {
    color: METEORA_COLORS.text,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '800',
  },
  noticeMessage: {
    color: METEORA_COLORS.textDim,
    fontSize: 11,
    lineHeight: 16,
  },
  fieldError: {
    borderColor: METEORA_COLORS.negative,
  },
  errorText: {
    marginTop: 5,
    marginLeft: 3,
    color: METEORA_COLORS.negative,
    fontSize: 11,
    lineHeight: 15,
  },
  disabled: {
    opacity: 0.48,
  },
  pressed: {
    opacity: 0.78,
  },
});
