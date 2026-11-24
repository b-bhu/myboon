/**
 * Portfolio table and allocation bar for the Home Wallet (issue #769).
 *
 * Design: docs/design/wallet.html at commit 37e0a51, frames "Slide-up and
 * Portfolio" and "States". The section only renders what #767's hook
 * (`useWalletSummary`) and #768's pure module (`wallet-portfolio.rows`)
 * give it — no fetching and no value maths here; the only arithmetic is
 * `sumUsd`, glue for the design's bar/total, in this file.
 *
 * Trust rule (wallet.html "Stale value held, retrying"): a failed refresh
 * never blanks a value already on screen. The previous mapping is kept
 * between refreshes, so a venue that answered before and fails now shows
 * its last value dimmed as stale with its own Retry — review of #778 note
 * (1); while it is stale the venue's own error text is kept by the mapping
 * — note (2); its Retry refetches the whole summary in one server call and
 * only the failed rows spin while that runs — note (3).
 *
 * Sample balances (`walletSummaryFixture`) are a "not deployed yet"
 * placeholder only (#780): they stand in when the server answered HTTP 404
 * for `/wallet/summary` and nothing real is held. Any other first-load
 * failure shows no numbers — a short "Couldn't load your portfolio" line
 * with one Retry in the Portfolio area. No addresses at all renders nothing
 * (the hook makes no call).
 *
 * While that first summary call is in flight (#858, frame "Portfolio
 * loading") the table shows five skeleton rows — icon block, two text bars
 * left, two short bars right, nothing spinning — and the app/spot counts
 * show short skeleton bars instead of a zero; nothing has loaded yet.
 *
 * Table view only; Map and Cards views come later. Spot rows open `/spot`
 * (the venue's current profile route); app rows open theirs via callbacks,
 * like the old rows below that #770 removes.
 */

import { memo, useCallback, useEffect, useState } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';

import { semantic, tokens } from '@/theme';
import { walletSummaryFixture, type WalletSummary } from '@myboon/shared/wallet-summary';
import { useWalletSummary } from '@/features/wallet/useWalletSummary';
import {
  mapWalletSummaryApps,
  shouldShowDemo,
  type WalletAppSourceStates,
} from '@/features/wallet/wallet-summary.mapping';
import {
  PORTFOLIO_APP_KEYS,
  portfolioRows,
  topFive,
  type AppPortfolioRow,
  type PortfolioAppKey,
  type SpotPortfolioRow,
} from '@/features/wallet/wallet-portfolio.rows';

const APP_NAME: Record<PortfolioAppKey, string> = {
  polymarket: 'Polymarket',
  phoenix: 'Phoenix',
  pacifica: 'Pacifica',
  meteora: 'Meteora',
};

/** #858: the loading table shows five skRow-shaped placeholders; stable keys. */
const SKELETON_ROW_KEYS = ['skel:0', 'skel:1', 'skel:2', 'skel:3', 'skel:4'];

function formatUsd(value: number): string {
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Glue for the design's total and bar segments; per-app values come from the mapping. */
function sumUsd(values: readonly (number | null)[]): number {
  return values.reduce((sum: number, value) => (value === null ? sum : sum + value), 0);
}

function ageLabel(asOf: string | null): string {
  if (!asOf) return '';
  const resolvedAtMs = Date.parse(asOf);
  if (Number.isNaN(resolvedAtMs)) return '';
  const minutes = Math.floor(Math.max(0, Date.now() - resolvedAtMs) / 60_000);
  if (minutes < 1) return 'just now';
  return `${minutes}m ago`;
}

/** One mapping pass, held across refreshes so a failed app turns stale, not unavailable. */
interface MappedPortfolio {
  /** `live:<addresses>` or `mock:<addresses>`; a change resets the chain. */
  identity: string;
  byApp: WalletAppSourceStates;
  /** Last listed row per app: recomputed while ok, carried while stale. */
  appRows: Partial<Record<PortfolioAppKey, AppPortfolioRow>>;
  spotRows: SpotPortfolioRow[];
}

export const PortfolioSection = memo(function PortfolioSection({
  solana,
  evm,
  onOpenPolymarket,
  onOpenPhoenix,
  onOpenPacifica,
  onOpenMeteora,
  onOpenSpot,
}: {
  solana: string | null;
  evm: string | null;
  onOpenPolymarket: () => void;
  onOpenPhoenix: () => void;
  onOpenPacifica: () => void;
  onOpenMeteora: () => void;
  onOpenSpot: () => void;
}) {
  const { summary, loading, error, errorStatus, retry } = useWalletSummary(solana, evm);
  const [seg, setSeg] = useState<'apps' | 'spot'>('apps');
  const [showAll, setShowAll] = useState(false);
  // Freshness labels tick like WalletHero's so ages never read frozen.
  const [, setTick] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(interval);
  }, []);

  const identityKey = `${solana ?? ''}|${evm ?? ''}`;
  // Sample data stands in only while the endpoint is not deployed yet (404;
  // #780) and nothing real is held; the first real summary replaces it.
  const isMock = shouldShowDemo(summary, loading, errorStatus);
  const display: WalletSummary | null = summary ?? (isMock ? walletSummaryFixture : null);
  const currentIdentity = `${summary ? 'live' : isMock ? 'mock' : 'none'}:${identityKey}`;

  const [mapped, setMapped] = useState<MappedPortfolio | null>(null);
  useEffect(() => {
    if (!display) return;
    setMapped((previous) => {
      // Keep the previous mapping between refreshes (#778 review note 1) so a
      // failed venue shows its last value as stale; a different wallet or the
      // mock → live handover resets the chain instead of carrying values.
      const prev = previous && previous.identity === currentIdentity ? previous : null;
      const byApp = mapWalletSummaryApps(display, prev ? prev.byApp : null);
      const current = portfolioRows(display);
      const appRows: Partial<Record<PortfolioAppKey, AppPortfolioRow>> = {};
      for (const key of PORTFOLIO_APP_KEYS) {
        const status = byApp[key].status;
        if (status === 'ok') {
          const row = current.apps.find((entry) => entry.id === key);
          if (row) appRows[key] = row;
        } else if (status === 'stale' && prev) {
          appRows[key] = prev.appRows[key];
        }
      }
      const spotRows = byApp.spot.status === 'ok'
        ? current.spot
        : byApp.spot.status === 'stale' && prev ? prev.spotRows : [];
      return { identity: currentIdentity, byApp, appRows, spotRows };
    });
  }, [display, currentIdentity]);

  const selectSeg = useCallback((next: 'apps' | 'spot') => {
    setShowAll(false);
    setSeg(next);
  }, []);

  // A first load that failed with anything but a "not deployed" 404 shows no
  // numbers (#780): unknown is unknown, never a number — one Retry instead,
  // in the existing Portfolio area.
  if (!display && !loading && error !== null) {
    return (
      <View style={styles.section}>
        <View style={styles.headerRow}>
          <Text accessibilityRole="header" style={styles.title}>Portfolio</Text>
        </View>
        <View style={styles.failRow}>
          <Text style={styles.failNote}>{"Couldn't load your portfolio"}</Text>
          <Pressable
            onPress={retry}
            accessibilityRole="button"
            accessibilityLabel="Retry your portfolio"
            hitSlop={8}
            style={({ pressed }) => [styles.retryBtn, pressed && styles.rowPressed]}
          >
            <Text style={styles.retryLabel}>Retry</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  // No addresses at all: the hook made no call, nothing to show.
  if (!display && !loading) return null;

  const state = mapped && mapped.identity === currentIdentity ? mapped : null;
  const showSkeletons = !state;

  const appCount = PORTFOLIO_APP_KEYS.filter((key) => state && state.byApp[key].status !== 'not_connected').length;
  const known = (key: PortfolioAppKey): number | null => {
    if (!state) return null;
    const app = state.byApp[key];
    return app.status === 'ok' || app.status === 'stale' ? app.valueUsd : null;
  };
  const spotValue = state && (state.byApp.spot.status === 'ok' || state.byApp.spot.status === 'stale')
    ? state.byApp.spot.valueUsd
    : null;
  const total = sumUsd([spotValue, ...PORTFOLIO_APP_KEYS.map(known)]);

  // Only failed rows spin while the (single) summary call is in flight —
  // #778 review note 3; healthy rows never do.
  const rowSpinner = (failed: boolean) => (loading && failed ? <RetrySpinner /> : null);

  const openApp: Record<PortfolioAppKey, () => void> = {
    polymarket: onOpenPolymarket,
    phoenix: onOpenPhoenix,
    pacifica: onOpenPacifica,
    meteora: onOpenMeteora,
  };

  type ListRow =
    // valueUsd at top level: every variant feeds #768's topFive.
    | { kind: 'app'; appKey: PortfolioAppKey; row: AppPortfolioRow; valueUsd: number; stale: boolean }
    // valueUsd is 0: a never-loaded app carries no value.
    | { kind: 'appError'; appKey: PortfolioAppKey; error: string | null; valueUsd: number }
    | { kind: 'spot'; row: SpotPortfolioRow; valueUsd: number };

  const list: ListRow[] = [];
  if (state) {
    if (seg === 'apps') {
      const listed: Extract<ListRow, { kind: 'app' }>[] = [];
      const failed: Extract<ListRow, { kind: 'appError' }>[] = [];
      for (const key of PORTFOLIO_APP_KEYS) {
        const app = state.byApp[key];
        const row = state.appRows[key];
        if (app.status === 'ok' && row) {
          listed.push({ kind: 'app', appKey: key, row, valueUsd: row.valueUsd, stale: false });
        } else if (app.status === 'stale' && row) {
          // The mapping still keeps the venue's error for stale states (#769),
          // but the row holds the value dimmed with its age — no error line (#863).
          listed.push({ kind: 'app', appKey: key, row, valueUsd: row.valueUsd, stale: true });
        } else if (app.status === 'unavailable') {
          failed.push({ kind: 'appError', appKey: key, error: app.error ?? null, valueUsd: 0 });
        }
        // not_connected: no row, no error (design "App not connected").
      }
      list.push(...[...listed].sort((a, b) => b.valueUsd - a.valueUsd), ...failed);
    } else {
      for (const row of state.spotRows) list.push({ kind: 'spot', row, valueUsd: row.valueUsd });
    }
  }
  const limit = showAll ? Math.max(list.length, 1) : 5;
  const { top, moreCount } = topFive(list, limit);
  const hiddenSum = moreCount > 0
    ? sumUsd(list.slice(list.length - moreCount).map((entry) => entry.valueUsd))
    : 0;
  const failedNames = state
    ? PORTFOLIO_APP_KEYS.filter((key) => state.byApp[key].status === 'unavailable').map((key) => APP_NAME[key])
    : [];

  return (
    <View style={styles.section}>
      <View style={styles.headerRow}>
        <Text accessibilityRole="header" style={styles.title}>Portfolio</Text>
        {isMock ? <Text style={styles.demoTag}>demo data</Text> : null}
      </View>

      {showSkeletons ? (
        <View style={styles.countLabelRow}>
          <Text style={styles.label}>Total balance · </Text>
          <View style={[styles.countSkeleton, styles.skeleton]} />
          <Text style={styles.label}> apps</Text>
        </View>
      ) : (
        <Text style={styles.label}>{`Total balance · ${appCount} apps`}</Text>
      )}
      {showSkeletons ? (
        <>
          <View style={[styles.totalSkeleton, styles.skeleton]} />
          <View style={[styles.barSkeleton, styles.skeleton]} />
        </>
      ) : (
        <>
          <Text style={styles.total}>{formatUsd(total)}</Text>
          <AllocationBar
            segments={[
              ...PORTFOLIO_APP_KEYS.map((key) => ({
                id: key,
                valueUsd: known(key),
                stale: (state?.byApp[key].status ?? 'not_connected') === 'stale',
              })),
              { id: 'spot' as const, valueUsd: spotValue, stale: state?.byApp.spot.status === 'stale' },
            ]}
          />
        </>
      )}

      <View
        accessibilityRole="tablist"
        style={styles.seg}
      >
        <Pressable
          accessibilityRole="tab"
          accessibilityState={{ selected: seg === 'apps' }}
          accessibilityLabel="Apps portfolio"
          onPress={() => selectSeg('apps')}
          style={[styles.segButton, seg === 'apps' && styles.segButtonOn]}
        >
          {showSkeletons ? (
            <View style={styles.countLabelRow}>
              <Text style={[styles.segLabel, seg === 'apps' && styles.segLabelOn]}>Apps · </Text>
              <View style={[styles.countSkeleton, styles.skeleton]} />
            </View>
          ) : (
            <Text style={[styles.segLabel, seg === 'apps' && styles.segLabelOn]}>{`Apps · ${appCount}`}</Text>
          )}
        </Pressable>
        <Pressable
          accessibilityRole="tab"
          accessibilityState={{ selected: seg === 'spot' }}
          accessibilityLabel="Spot token holdings"
          onPress={() => selectSeg('spot')}
          style={[styles.segButton, seg === 'spot' && styles.segButtonOn]}
        >
          {showSkeletons ? (
            <View style={styles.countLabelRow}>
              <Text style={[styles.segLabel, seg === 'spot' && styles.segLabelOn]}>Spot · </Text>
              <View style={[styles.countSkeleton, styles.skeleton]} />
            </View>
          ) : (
            <Text style={[styles.segLabel, seg === 'spot' && styles.segLabelOn]}>{`Spot · ${state ? state.spotRows.length : 0}`}</Text>
          )}
        </Pressable>
      </View>

      <View style={styles.table}>
        {showSkeletons
          ? SKELETON_ROW_KEYS.map((key) => <PortfolioSkeletonRow key={key} />)
          : top.map((entry) => {
          if (entry.kind === 'spot') {
            return (
              <View key={`spot:${entry.row.mint}`} style={styles.row}>
                <Pressable
                  onPress={onOpenSpot}
                  accessibilityRole="button"
                  accessibilityLabel={`Open ${entry.row.symbol ?? 'token'} in Spot`}
                  style={({ pressed }) => [styles.rowMain, pressed && styles.rowPressed]}
                >
                  <View style={styles.nameCol}>
                    <Text numberOfLines={1} style={[styles.name, { color: tokens.walletBrand.spot }]}>
                      {entry.row.symbol ?? 'Token'}
                    </Text>
                  </View>
                  <Text style={[styles.value, seg === 'spot' && state?.byApp.spot.status === 'stale' && styles.rowStaleValue]}>
                    {formatUsd(entry.row.valueUsd)}
                  </Text>
                </Pressable>
                <MaterialIcons name="chevron-right" size={14} color={semantic.text.faint} />
              </View>
            );
          }
          if (entry.kind === 'appError') {
            const name = APP_NAME[entry.appKey];
            return (
              <View key={`err:${entry.appKey}`} style={styles.row}>
                <View style={[styles.rowMain, styles.nameCol]}>
                  <Text numberOfLines={1} style={[styles.name, { color: tokens.walletBrand[entry.appKey] }]}>
                    {name}
                  </Text>
                  <Text numberOfLines={1} style={styles.failLine}>
                    {"Couldn't load · the rest are fine"}
                  </Text>
                </View>
                {rowSpinner(true)}
                <Pressable
                  onPress={retry}
                  accessibilityRole="button"
                  accessibilityLabel={`Retry ${name}`}
                  hitSlop={8}
                  style={({ pressed }) => [styles.retryBtn, pressed && styles.rowPressed]}
                >
                  <Text style={styles.retryLabel}>Retry</Text>
                </Pressable>
              </View>
            );
          }
          const name = APP_NAME[entry.appKey];
          return (
            <View key={`app:${entry.appKey}`} style={styles.row}>
              <Pressable
                onPress={openApp[entry.appKey]}
                accessibilityRole="button"
                accessibilityLabel={`Open ${name} portfolio`}
                style={({ pressed }) => [styles.rowMain, pressed && styles.rowPressed]}
              >
                <View style={styles.nameCol}>
                  <Text numberOfLines={1} style={[styles.name, { color: tokens.walletBrand[entry.appKey] }]}>
                    {name}
                  </Text>
                  <Text numberOfLines={1} style={styles.line}>{entry.row.summaryLine}</Text>
                </View>
                <View style={styles.valueCol}>
                  <Text style={[styles.value, entry.stale && styles.rowStaleValue]}>
                    {formatUsd(entry.row.valueUsd)}
                  </Text>
                  {entry.stale ? (
                    <View style={styles.ageRow}>
                      {rowSpinner(true)}
                      <Text style={styles.ageLabel}>{ageLabel(state?.byApp[entry.appKey].asOf ?? null)}</Text>
                    </View>
                  ) : null}
                </View>
              </Pressable>
              {entry.stale ? (
                <View style={styles.retryCol}>
                  <Pressable
                    onPress={retry}
                    accessibilityRole="button"
                    accessibilityLabel={`Retry ${name}`}
                    hitSlop={8}
                    style={({ pressed }) => [styles.retryBtn, pressed && styles.rowPressed]}
                  >
                    <Text style={styles.retryLabel}>Retry</Text>
                  </Pressable>
                </View>
              ) : (
                <MaterialIcons name="chevron-right" size={14} color={semantic.text.faint} />
              )}
            </View>
          );
        })}
        {display !== null && list.length === 0 && !showSkeletons ? (
          <Text style={styles.failLine}>{seg === 'spot' ? 'No spot holdings yet.' : 'No app balances yet.'}</Text>
        ) : null}
        {moreCount > 0 ? (
          <Pressable
            onPress={() => setShowAll(true)}
            accessibilityRole="button"
            accessibilityLabel={`Show all ${list.length} rows`}
            style={({ pressed }) => [styles.moreRow, pressed && styles.rowPressed]}
          >
            <Text style={styles.moreLabel}>{`+${moreCount} more · ${formatUsd(hiddenSum)}`}</Text>
            <Text style={styles.moreAction}>Show all</Text>
          </Pressable>
        ) : null}
      </View>

      {failedNames.length > 0 && seg === 'apps' ? (
        <Text style={styles.failNote}>{`Total leaves out ${failedNames.join(', ')} until it loads.`}</Text>
      ) : null}
    </View>
  );
});

/** One #858 loading row, as the frame's skRow draws it: a square icon block,
 * two text bars on the left and two short bars on the right — never a spinner. */
function PortfolioSkeletonRow() {
  return (
    <View style={styles.row}>
      <View style={[styles.skelIcon, styles.skeleton]} />
      <View style={styles.skelNameCol}>
        <View style={[styles.skelBarLg, styles.skeleton]} />
        <View style={[styles.skelBarMd, styles.skeleton]} />
      </View>
      <View style={styles.skelValueCol}>
        <View style={[styles.skelBarLg, styles.skeleton]} />
        <View style={[styles.skelBarSm, styles.skeleton]} />
      </View>
    </View>
  );
}

/** The unused mix bar from WalletHero, reused: brand-colored flex segments. */
function AllocationBar({
  segments,
}: {
  segments: readonly { id: PortfolioAppKey | 'spot'; valueUsd: number | null; stale: boolean }[];
}) {
  const known = segments.filter((segment): segment is { id: PortfolioAppKey | 'spot'; valueUsd: number; stale: boolean } => segment.valueUsd !== null);
  return (
    <View style={styles.bar}>
      {known.length > 0
        ? known.map((segment) => (
          <View
            key={segment.id}
            style={[
              styles.barSegment,
              {
                flexGrow: Math.max(segment.valueUsd, 0.0001),
                backgroundColor: tokens.walletBrand[segment.id],
                opacity: segment.stale ? 0.45 : 1,
              },
            ]}
          />
        ))
        : <View style={[styles.barSegment, styles.barSegmentPending, { flexGrow: 1 }]} />}
    </View>
  );
}

function RetrySpinner() {
  const [rotation] = useState(() => new Animated.Value(0));
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(rotation, { toValue: 1, duration: 800, easing: Easing.linear, useNativeDriver: true }),
    );
    loop.start();
    return () => loop.stop();
  }, [rotation]);
  const spin = rotation.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  return (
    <Animated.Text style={[styles.spinner, { transform: [{ rotate: spin }] }]}>{'↻'}</Animated.Text>
  );
}

const styles = StyleSheet.create({
  section: { gap: 10 },
  headerRow: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  title: { color: semantic.text.primary, fontSize: 18, fontWeight: '800' },
  demoTag: {
    color: tokens.colors.accent,
    fontFamily: 'monospace',
    fontSize: 9,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  label: {
    color: semantic.text.faint,
    fontFamily: 'monospace',
    fontSize: 10,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  total: { color: semantic.text.primary, fontFamily: 'monospace', fontSize: 26, fontWeight: '700' },
  totalSkeleton: { width: 160, height: 30, borderRadius: 5 },
  barSkeleton: { height: 8, borderRadius: 4 },
  skeleton: { backgroundColor: semantic.background.lift },
  // #858 skRow placeholders: 28×28 rounded icon, left text bars, right value bars.
  skelIcon: { width: 28, height: 28, borderRadius: 6 },
  skelNameCol: { flex: 1, minWidth: 0, gap: 8 },
  skelValueCol: { alignItems: 'flex-end', gap: 8 },
  skelBarLg: { width: 96, height: 12, borderRadius: 4 },
  skelBarMd: { width: 170, height: 10, borderRadius: 4 },
  skelBarSm: { width: 32, height: 10, borderRadius: 4 },
  // Short bar where a count goes while nothing has loaded yet (#858).
  countLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  countSkeleton: { width: 22, height: 10, borderRadius: 4 },
  bar: {
    flexDirection: 'row',
    width: '100%',
    height: 6,
    borderRadius: 3,
    overflow: 'hidden',
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  barSegment: { height: '100%' },
  barSegmentPending: { backgroundColor: 'rgba(255,255,255,0.08)' },
  seg: {
    width: '100%',
    flexDirection: 'row',
    padding: 3,
    gap: 4,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(24,90,112,0.78)',
    backgroundColor: 'rgba(8,61,80,0.60)',
  },
  segButton: {
    flex: 1,
    minHeight: 44,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segButtonOn: { backgroundColor: semantic.background.lift },
  segLabel: { color: semantic.text.faint, fontSize: 11, fontWeight: '600', letterSpacing: 0.8, textTransform: 'uppercase' },
  segLabelOn: { color: semantic.text.primary },
  table: { gap: 0 },
  row: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(24,90,112,0.6)',
  },
  rowMain: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 8,
  },
  rowPressed: { opacity: 0.82 },
  // The design dims only the held number (".tr.stale .rt b"), not the row.
  rowStaleValue: { opacity: 0.65 },
  nameCol: { flex: 1, minWidth: 0, gap: 3 },
  name: { fontSize: 13.5, fontWeight: '800' },
  line: {
    color: semantic.text.faint,
    fontFamily: 'monospace',
    fontSize: 10.5,
  },
  failLine: {
    color: semantic.text.faint,
    fontFamily: 'monospace',
    fontSize: 10.5,
    fontStyle: 'italic',
  },
  valueCol: { alignItems: 'flex-end', gap: 3 },
  value: {
    color: semantic.text.primary,
    fontFamily: 'monospace',
    fontSize: 15,
    fontWeight: '800',
    letterSpacing: -0.2,
  },
  ageRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  ageLabel: { color: semantic.text.faint, fontFamily: 'monospace', fontSize: 9 },
  spinner: { color: tokens.colors.accent, fontSize: 10, lineHeight: 11 },
  retryCol: { alignItems: 'center' },
  retryBtn: { paddingHorizontal: 6, paddingVertical: 10 },
  retryLabel: {
    color: tokens.colors.primary,
    fontFamily: 'monospace',
    fontSize: 10,
    fontWeight: '800',
    textDecorationLine: 'underline',
  },
  moreRow: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 2,
  },
  moreLabel: { color: semantic.text.faint, fontFamily: 'monospace', fontSize: 12 },
  moreAction: { color: tokens.colors.accent, fontFamily: 'monospace', fontSize: 12, fontWeight: '700' },
  failNote: {
    color: semantic.text.faint,
    fontFamily: 'monospace',
    fontSize: 10.5,
  },
  failRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 4 },
});
