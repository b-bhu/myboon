import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { semantic, tokens } from '@/theme';
import type {
  MeteoraRowDetail,
  SpotChipToken,
  SpotRowDetail,
  WalletProtocolId,
  WalletSourceState,
} from '@/features/wallet/wallet.types';

/**
 * Shared Spot/Meteora account row for Home's Wallet section (issue #238).
 *
 * No icon badges, no colored left-edge rail (PRD design decision #15,
 * TC-ROWS-007) — protocol identity is carried entirely by the row's name
 * text color and a faint background tint drawn from that protocol's real
 * brand color. Each row shows exactly one dollar value (PRD decision #7,
 * TC-ROWS-001); multiple positions render as small pills/chips rather than a
 * spelled-out count (PRD decision #17).
 */

const ROW_LABEL: Record<'spot' | 'meteora', string> = {
  spot: 'Spot',
  meteora: 'Meteora',
};

const ROW_TINT: Record<'spot' | 'meteora', string> = {
  // Faint per-protocol background wash, matching wallet_mock.html's
  // `.acc-row.{spot,meteora}` gradient stops.
  spot: 'rgba(153,69,255,0.07)',
  meteora: 'rgba(110,69,255,0.08)',
};

const ROW_NAME_COLOR: Record<'spot' | 'meteora', string> = {
  spot: tokens.walletBrand.spot,
  meteora: tokens.walletBrand.meteora,
};

function formatUsd(value: number): string {
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function WalletAccountRow({
  protocol,
  source,
  onRetry,
  onPress,
}: {
  protocol: 'spot' | 'meteora';
  source: WalletSourceState;
  onRetry: (id: WalletProtocolId) => void;
  /**
   * Tap-through destination for this row (issue #240). Spot has no profile
   * screen anywhere in the app, so it is never passed an `onPress` — the row
   * renders as visually non-interactive (no chevron, not `Pressable`) rather
   * than a dead tap target (PRD decision #7, TC-NAV-004).
   */
  onPress?: () => void;
}) {
  // A value is shown whenever one has ever resolved — including while a retry
  // of a stale row is in flight (status 'loading' but a prior value is still
  // held) — so a previously-known value is never blanked mid-retry
  // (TC-STATE-003, TC-STATE-005).
  const hasValue = source.valueUsd !== null && source.resolvedAt !== null;
  const isStale = source.status === 'stale' || (source.status === 'loading' && hasValue);
  const isPending = (source.status === 'idle' || source.status === 'loading' || source.status === 'failed') && !hasValue;

  /**
   * The tappable part of the row: name, value, and detail.
   *
   * Deliberately excludes the retry affordances below. React Native Web renders
   * a `Pressable` with `accessibilityRole="button"` as a real `<button>`, and a
   * `<button>` inside a `<button>` is invalid HTML — React logs a hydration
   * error and the inner control does not reliably receive clicks. So the retry
   * buttons are siblings of this pressable, never descendants.
   */
  const summary = (
    <>
      <View style={styles.topRow}>
        <View style={styles.nameRow}>
          <Text style={[styles.name, { color: ROW_NAME_COLOR[protocol] }]}>{ROW_LABEL[protocol]}</Text>
          {onPress ? (
            <MaterialIcons name="chevron-right" size={14} color={semantic.text.faint} />
          ) : null}
        </View>
        {hasValue && source.valueUsd !== null ? (
          <Text style={styles.value}>{formatUsd(source.valueUsd)}</Text>
        ) : (
          <View style={styles.valueSkeleton} />
        )}
      </View>

      {hasValue ? <RowSignal protocol={protocol} detail={source.detail} /> : null}
    </>
  );

  const signals = (
    <>
      {isStale ? (
        <StaleSignal resolvedAt={source.resolvedAt} onRetry={() => onRetry(protocol)} />
      ) : null}

      {!hasValue ? (
        <SyncingSignal
          failed={source.status === 'failed'}
          onRetry={() => onRetry(protocol)}
        />
      ) : null}
    </>
  );

  return (
    <View style={[styles.row, { backgroundColor: ROW_TINT[protocol] }, isPending && styles.rowPending]}>
      {onPress ? (
        <Pressable
          onPress={onPress}
          accessibilityRole="button"
          accessibilityLabel={`Open ${ROW_LABEL[protocol]}`}
          style={({ pressed }) => [styles.summary, pressed && styles.rowPressed]}
        >
          {summary}
        </Pressable>
      ) : (
        <View style={styles.summary}>{summary}</View>
      )}
      {signals}
    </View>
  );
}

function RowSignal({
  protocol,
  detail,
}: {
  protocol: 'spot' | 'meteora';
  detail: WalletSourceState['detail'];
}) {
  if (protocol === 'spot') {
    return <SpotSignal detail={detail as SpotRowDetail | null} />;
  }
  return <MeteoraSignal detail={detail as MeteoraRowDetail | null} />;
}

function SpotSignal({ detail }: { detail: SpotRowDetail | null }) {
  // Zero-position/zero-holding row (TC-ROWS-006): row stays visible with its
  // real value and no chips, rather than an empty or broken-looking row.
  if (!detail || detail.topTokens.length === 0) return null;

  return (
    <View style={styles.tokenStack}>
      {detail.topTokens.map((token, index) => (
        <TokenChip key={token.mint} token={token} overlap={index > 0} />
      ))}
      {detail.overflowCount > 0 ? (
        <View style={[styles.tokenChip, styles.overflowChip, styles.tokenChipOverlap]}>
          <Text style={styles.overflowChipText}>{`+${detail.overflowCount}`}</Text>
        </View>
      ) : null}
    </View>
  );
}

// Distinct, deterministic fallback colors for tokens with no logo (e.g.
// obscure/unverified tokens per issue #238) — picked from the existing
// walletBrand palette so fallback chips still read as "myboon-native" rather
// than introducing new arbitrary colors.
const FALLBACK_CHIP_COLORS = [
  tokens.walletBrand.spot,
  tokens.walletBrand.meteora,
  tokens.walletBrand.phoenix,
  tokens.walletBrand.pacifica,
];

function fallbackChipColor(mint: string): string {
  let hash = 0;
  for (let i = 0; i < mint.length; i += 1) {
    hash = (hash * 31 + mint.charCodeAt(i)) | 0;
  }
  return FALLBACK_CHIP_COLORS[Math.abs(hash) % FALLBACK_CHIP_COLORS.length];
}

function TokenChip({ token, overlap }: { token: SpotChipToken; overlap: boolean }) {
  const initial = (token.symbol ?? '?').trim().charAt(0).toUpperCase() || '?';
  return (
    <View style={[styles.tokenChip, overlap && styles.tokenChipOverlap]}>
      {token.logoUri ? (
        <Image source={{ uri: token.logoUri }} style={styles.tokenChipImage} />
      ) : (
        <View style={[styles.tokenChipFallback, { backgroundColor: fallbackChipColor(token.mint) }]}>
          <Text style={styles.tokenChipFallbackText}>{initial}</Text>
        </View>
      )}
    </View>
  );
}

function MeteoraSignal({ detail }: { detail: MeteoraRowDetail | null }) {
  // Zero-position row (TC-ROWS-006): still shown, no pills.
  if (!detail || detail.pills.length === 0) return null;

  return (
    <View style={styles.meteoraSignal}>
      <View style={styles.pillRow}>
        {detail.pills.map((pill) => (
          <View
            key={pill.poolAddress}
            style={[
              styles.pill,
              pill.inRange === true && styles.pillWin,
              pill.inRange === false && styles.pillLose,
            ]}
          >
            <View
              style={[
                styles.pillRing,
                pill.inRange === true && styles.ringIn,
                pill.inRange === false && styles.ringOut,
              ]}
            />
            <Text style={styles.pillText} numberOfLines={1}>{pill.pair}</Text>
          </View>
        ))}
      </View>
      {detail.unclaimedFeesUsd !== null ? (
        <Text style={styles.feesText}>{`${formatUsd(detail.unclaimedFeesUsd)} fees`}</Text>
      ) : null}
    </View>
  );
}

function SyncingSignal({ failed, onRetry }: { failed: boolean; onRetry: () => void }) {
  // "syncing" (still in flight) and a failed attempt must never look
  // identical — a failed row keeps the PRD's non-alarming tone (never
  // "Unavailable"/"Error") but needs its own distinct wording and a static
  // (non-spinning-implying) marker, so it doesn't read as "still loading."
  return (
    <View style={styles.syncingRow}>
      <View style={[styles.spinnerDot, failed && styles.spinnerDotFailed]} />
      <Text style={styles.syncingText}>{failed ? "couldn't sync" : 'syncing'}</Text>
      {failed ? (
        <Pressable
          onPress={onRetry}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Retry syncing this balance"
        >
          <Text style={styles.retryLink}>Retry</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function formatStaleFreshness(resolvedAtMs: number | null): string {
  if (resolvedAtMs === null) return 'stale';
  const minutes = Math.max(0, Math.floor((Date.now() - resolvedAtMs) / 60_000));
  if (minutes < 1) return 'stale · as of just now';
  if (minutes === 1) return 'stale · as of 1 min ago';
  return `stale · as of ${minutes} min ago`;
}

/**
 * TC-STATE-003: a source that has a real, previously-fetched value but whose
 * latest refresh failed — the row keeps its last known value and this label,
 * distinct from the dashed-border "syncing" pending/never-loaded treatment.
 */
function StaleSignal({ resolvedAt, onRetry }: { resolvedAt: number | null; onRetry: () => void }) {
  return (
    <View style={styles.syncingRow}>
      <Text style={styles.staleText}>{formatStaleFreshness(resolvedAt)}</Text>
      <Pressable
        onPress={onRetry}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel="Retry syncing this balance"
      >
        <Text style={styles.retryLink}>Retry</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(24,90,112,0.78)',
    backgroundColor: 'rgba(8,61,80,0.90)',
    padding: 11,
    paddingHorizontal: 12,
  },
  rowPending: {
    borderStyle: 'dashed',
    borderColor: 'rgba(255,209,102,0.35)',
  },
  rowPressed: {
    opacity: 0.82,
  },
  /**
   * The tappable summary. Carries no padding or background of its own — the
   * parent `row` owns those — so splitting the row into a pressable summary
   * plus sibling retry controls is visually identical to the old single
   * pressable, while keeping the retry `<button>` out of the outer one.
   */
  summary: {
    alignSelf: 'stretch',
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: tokens.spacing.sm,
    marginBottom: 5,
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  name: {
    fontSize: 13.5,
    fontWeight: '800',
  },
  value: {
    color: semantic.text.primary,
    fontFamily: 'monospace',
    fontSize: 15,
    fontWeight: '800',
    letterSpacing: -0.2,
  },
  valueSkeleton: {
    width: 64,
    height: 15,
    borderRadius: 4,
    backgroundColor: semantic.background.lift,
  },
  tokenStack: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  tokenChip: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: 'rgba(8,61,80,0.90)',
    overflow: 'hidden',
    backgroundColor: semantic.background.lift,
  },
  tokenChipOverlap: {
    marginLeft: -6,
  },
  tokenChipImage: {
    width: '100%',
    height: '100%',
  },
  tokenChipFallback: {
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  tokenChipFallbackText: {
    color: semantic.text.primary,
    fontFamily: 'monospace',
    fontSize: 8,
    fontWeight: '800',
  },
  overflowChip: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: semantic.background.lift,
  },
  overflowChipText: {
    color: semantic.text.dim,
    fontFamily: 'monospace',
    fontSize: 7,
    fontWeight: '800',
  },
  meteoraSignal: {
    gap: 4,
  },
  pillRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 5,
  },
  feesText: {
    color: semantic.text.faint,
    fontFamily: 'monospace',
    fontSize: 8,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 3,
    paddingHorizontal: 6,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1.5,
    borderColor: 'transparent',
  },
  pillWin: {
    borderColor: 'rgba(6,214,160,0.5)',
  },
  pillLose: {
    borderColor: 'rgba(239,71,111,0.5)',
  },
  pillRing: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    borderWidth: 1.5,
    borderColor: semantic.text.faint,
  },
  ringIn: {
    borderColor: semantic.sentiment.positive,
  },
  ringOut: {
    borderColor: semantic.sentiment.negative,
  },
  pillText: {
    color: semantic.text.primary,
    fontFamily: 'monospace',
    fontSize: 8,
    fontWeight: '700',
    letterSpacing: 0.1,
  },
  syncingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  staleText: {
    color: semantic.text.faint,
    fontFamily: 'monospace',
    fontSize: 8.5,
    fontStyle: 'italic',
  },
  spinnerDot: {
    width: 9,
    height: 9,
    borderRadius: 4.5,
    borderWidth: 1.5,
    borderColor: 'rgba(255,209,102,0.25)',
    borderTopColor: tokens.colors.accent,
  },
  // Failed: a solid, still dot — deliberately not the ring shape used for
  // "syncing," so it reads as "stopped" rather than "in progress."
  spinnerDotFailed: {
    borderWidth: 0,
    backgroundColor: tokens.colors.accent,
  },
  syncingText: {
    color: tokens.colors.accent,
    fontFamily: 'monospace',
    fontSize: 8.5,
  },
  retryLink: {
    color: tokens.colors.primary,
    fontFamily: 'monospace',
    fontSize: 8.5,
    fontWeight: '800',
    textDecorationLine: 'underline',
  },
});
