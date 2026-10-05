import { Pressable, StyleSheet, Text, View } from 'react-native';
import { formatAtomicAmount } from '@/features/swap/swap.math';
import { exchangeRate, providerFee } from '@/features/swap/swap.display';
import { swapTheme as color } from '@/features/swap/swap.theme';
import { SwipeToConfirm } from '@/features/swap/components/SwipeToConfirm';
import type { SwapController } from '@/features/swap/useSwapController';

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.detail}>
      <Text style={styles.label}>{label}</Text>
      <Text selectable style={styles.value}>
        {value}
      </Text>
    </View>
  );
}

const phaseCopy: Partial<Record<SwapController['phase'], string>> = {
  ordering: 'Building your swap…',
  validating: 'Checking the transaction…',
  simulating: 'Checking the expected result…',
  awaiting_signature: 'Approve the swap in your wallet',
  executing: 'Sending swap…',
  unknown: 'This swap needs a status check. Do not submit it again.',
};

/** Shared inline/routed review. Only the controller can prepare, sign or execute. */
export function SwapReview({ controller: c }: { controller: SwapController }) {
  const order = c.reviewOrder;
  const fee = (amount: string | null) =>
    amount === null ? 'Unavailable' : `${formatAtomicAmount(amount, 9, 9)} SOL`;
  return (
    <View style={styles.review}>
      {order ? (
        <>
          <View style={styles.summary}>
            <Text style={styles.label}>You pay</Text>
            <Text selectable style={styles.amount}>
              {formatAtomicAmount(
                order.inAmountAtomic,
                c.inputToken.decimals,
                c.inputToken.decimals,
              )}{' '}
              {c.inputToken.symbol}
            </Text>
            <Text style={styles.arrow}>↓</Text>
            <Text style={styles.label}>You receive</Text>
            <Text selectable style={styles.amount}>
              {formatAtomicAmount(
                order.outAmountAtomic,
                c.outputToken.decimals,
                c.outputToken.decimals,
              )}{' '}
              {c.outputToken.symbol}
            </Text>
          </View>
          <Detail label="Exchange rate" value={exchangeRate(order, c.inputToken, c.outputToken)} />
          <Detail
            label="Minimum received"
            value={`${formatAtomicAmount(order.minimumOutAmountAtomic, c.outputToken.decimals, c.outputToken.decimals)} ${c.outputToken.symbol}`}
          />
          <Detail label="Slippage" value={`${order.slippageBps / 100}%`} />
          <Detail
            label="Price impact"
            value={order.priceImpactPct === null ? 'Unavailable' : `${order.priceImpactPct}%`}
          />
          <Detail label="Provider fee" value={providerFee(order, c.inputToken, c.outputToken)} />
          <Detail label="Signature fee" value={fee(order.fees.signatureFeeLamports)} />
          <Detail label="Priority fee" value={fee(order.fees.priorityFeeLamports)} />
          <Detail label="Account creation" value={fee(order.fees.rentFeeLamports)} />
          <Detail label="MyBoon fee" value={order.fees.myboonFeeAtomic} />
          <Detail
            label="Route"
            value={
              order.route.length
                ? order.route.map((step) => `${step.label} ${step.percent}%`).join(' · ')
                : order.router
            }
          />
        </>
      ) : null}
      {c.simulationWarning ? (
        <Text selectable accessibilityRole="alert" style={styles.warning}>
          {c.simulationWarning}
        </Text>
      ) : null}
      {c.phase === 'reviewing' && order ? (
        c.simulationWarning && !c.simulationWarningAccepted ? (
          <Pressable
            onPress={() => c.setSimulationWarningAccepted(true)}
            accessibilityRole="button"
            accessibilityLabel="Acknowledge simulation unavailable"
            style={styles.button}
          >
            <Text style={styles.buttonLabel}>Acknowledge simulation unavailable</Text>
          </Pressable>
        ) : (
          <SwipeToConfirm
            receiveAmount={c.receiveAtLeast}
            outputToken={c.outputToken}
            onComplete={() => void c.confirmTrade()}
          />
        )
      ) : null}
      {phaseCopy[c.phase] ? (
        <Text accessibilityLiveRegion="polite" style={styles.status}>
          {phaseCopy[c.phase]}
        </Text>
      ) : null}
      {c.phase === 'confirmed' ? (
        <Text accessibilityLiveRegion="polite" style={styles.success}>
          Swap confirmed
        </Text>
      ) : null}
      {c.failure ? (
        <Text selectable accessibilityRole="alert" style={styles.error}>
          {c.failure}
        </Text>
      ) : null}
      {c.resultMessage ? (
        <Text selectable style={styles.status}>
          {c.resultMessage}
        </Text>
      ) : null}
      {c.pendingError ? (
        <Text selectable accessibilityRole="alert" style={styles.error}>
          {c.pendingError}
        </Text>
      ) : null}
      {c.phase === 'unknown' || c.pendingError ? (
        <Pressable
          onPress={() => void c.reconcilePending()}
          style={styles.button}
          accessibilityRole="button"
          accessibilityLabel="Check pending swap status"
        >
          <Text style={styles.buttonLabel}>Check status</Text>
        </Pressable>
      ) : null}
      {c.phase === 'failed' ? (
        <Pressable
          onPress={c.retry}
          style={styles.button}
          accessibilityRole="button"
          accessibilityLabel="Refresh quote and retry"
        >
          <Text style={styles.buttonLabel}>Refresh quote</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  review: { gap: 10 },
  summary: {
    padding: 14,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: color.border,
    backgroundColor: color.card,
    gap: 6,
  },
  label: { color: color.dim, fontSize: 13, lineHeight: 19 },
  amount: { color: color.text, fontSize: 25, fontWeight: '600', fontVariant: ['tabular-nums'] },
  arrow: { color: color.gold, fontSize: 22 },
  detail: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    borderBottomWidth: 1,
    borderColor: color.border,
    paddingVertical: 8,
  },
  value: {
    flex: 1,
    color: color.text,
    fontSize: 13,
    textAlign: 'right',
    fontVariant: ['tabular-nums'],
  },
  warning: { color: color.gold, fontSize: 14, lineHeight: 20 },
  error: { color: color.error, fontSize: 14, lineHeight: 20 },
  success: { color: color.positive, fontSize: 16, fontWeight: '700' },
  status: { color: color.dim, fontSize: 14, lineHeight: 20 },
  button: {
    minHeight: 48,
    padding: 12,
    borderRadius: 10,
    backgroundColor: color.gold,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonLabel: { color: color.navy, fontSize: 14, fontWeight: '700', textAlign: 'center' },
});
