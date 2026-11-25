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
 * The body is the table, the Map treemap (#871's `PortfolioMap`) or, with
 * Cards chosen (#842), `PortfolioCards` over the same entries: the header's
 * Table | Map | Cards switch (#840, the design's ".vs" in frame "Portfolio
 * · Map") carries and remembers the choice, and its disabled segments reopen
 * as Table via `portfolio-view`'s parse. The Spot segment lists one row per chain —
 * v1: Solana only, no EVM row (issue #770) — labelled "Spot", opening
 * `/spot`, the venue's current profile route (#844 moves that tap to the
 * token list); app rows open theirs via callbacks, like the old rows below
 * that #905 removes.
 *
 * #843 keeps the table still while the sheet is dragged: every row is a `memo`
 * component on its data props (the press handlers travel through stable
 * dispatchers), so a drag-time render — the boundary flip, a refresh landing
 * mid-drag, or the 30s age tick — re-renders only the rows whose displayed
 * values changed, and the pull-to-refresh control in HomeWalletOverview is
 * mounted only while the panel is expanded with its list at the top.
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';

import { semantic, tokens } from '@/theme';
import { NO_DATA } from '@/lib/format';
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
import {
  METEORA_MARK_SVG,
  PACIFICA_MARK_SVG,
  PHOENIX_MARK_SVG,
  POLYMARKET_MARK_SVG,
} from '@/features/home/marketBrandAssets';
import { PortfolioCards, type PortfolioCardItem } from '@/features/wallet/components/PortfolioCards';
import { PortfolioMap, type PortfolioMapItem } from '@/features/wallet/components/PortfolioMap';
import { pnlChipText, portfolioCardPnl } from '@/features/wallet/portfolio-cards';
import {
  DEFAULT_PORTFOLIO_VIEW,
  ENABLED_PORTFOLIO_VIEWS,
  readPortfolioView,
  writePortfolioView,
  type PortfolioView,
} from '@/features/wallet/portfolio-view';

const APP_NAME: Record<PortfolioAppKey, string> = {
  polymarket: 'Polymarket',
  phoenix: 'Phoenix',
  pacifica: 'Pacifica',
  meteora: 'Meteora',
};

/** The apps' brand marks (the Home screen's), drawn on the Cards view (#842). */
const APP_MARK_SVG: Record<PortfolioAppKey, string> = {
  polymarket: POLYMARKET_MARK_SVG,
  phoenix: PHOENIX_MARK_SVG,
  pacifica: PACIFICA_MARK_SVG,
  meteora: METEORA_MARK_SVG,
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
  onSelectApp,
  onOpenSpot,
}: {
  solana: string | null;
  evm: string | null;
  onOpenPolymarket: () => void;
  onOpenPhoenix: () => void;
  onOpenPacifica: () => void;
  onOpenMeteora: () => void;
  onSelectApp?: (app: 'meteora' | 'phoenix' | 'pacifica' | 'spot') => void;
  onOpenSpot: () => void;
}) {
  const { summary, loading, error, errorStatus, retry } = useWalletSummary(solana, evm);
  const [seg, setSeg] = useState<'apps' | 'spot'>('apps');
  const [showAll, setShowAll] = useState(false);
  // The remembered view (#840): Table first open, the stored choice once the
  // read settles. Map renders since #871, so all three segments are live.
  const [view, setView] = useState<PortfolioView>(DEFAULT_PORTFOLIO_VIEW);
  useEffect(() => {
    let cancelled = false;
    readPortfolioView().then((stored) => {
      if (!cancelled) setView(stored);
    });
    return () => {
      cancelled = true;
    };
  }, []);
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

  // Disabled segments are inert (their button is disabled); the guard also
  // keeps the choice write to enabled views only (issue #840).
  const selectView = useCallback((next: PortfolioView) => {
    if (!ENABLED_PORTFOLIO_VIEWS.includes(next)) return;
    setView(next);
    void writePortfolioView(next);
  }, []);

  // Press handlers travel by latest-ref (#843): the screen passes fresh
  // closures on every render, and a memo'd row would see a new callback
  // identity each time. Rows receive one stable dispatcher per segment that
  // reads the newest closure here, so a drag-time re-render never rebuilds
  // the table.
  const openAppRef = useRef<Partial<Record<PortfolioAppKey, () => void>>>({});
  openAppRef.current = {
    polymarket: onOpenPolymarket,
    // #855: like Meteora, the Phoenix row opens the Wallet's app view when
    // the screen passes onSelectApp; without it the old profile route.
    phoenix: onSelectApp ? () => onSelectApp('phoenix') : onOpenPhoenix,
    // #857: the Pacifica row opens the app view the same way.
    pacifica: onSelectApp ? () => onSelectApp('pacifica') : onOpenPacifica,
    // #856: when the screen passes onSelectApp, the Meteora row opens the
    // Wallet's app view (dispatches `select`); without it the row keeps the
    // old profile route.
    meteora: onSelectApp ? () => onSelectApp('meteora') : onOpenMeteora,
  };
  const openSpotRef = useRef(onOpenSpot);
  // #844: with onSelectApp the Solana Spot row opens the Spot app view; without
  // it the row keeps the old /spot route.
  openSpotRef.current = onSelectApp ? () => onSelectApp('spot') : onOpenSpot;
  const openAppRow = useCallback((key: PortfolioAppKey) => openAppRef.current[key]?.(), []);
  const openSpotRow = useCallback(() => openSpotRef.current?.(), []);

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
      // `?? 0` is for the sort only, like the failed app rows above; the
      // row's own value slot shows the no-data glyph for null (#770).
      for (const row of state.spotRows) list.push({ kind: 'spot', row, valueUsd: row.valueUsd ?? 0 });
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
  // The spot value dims only in the spot segment while the venue is stale —
  // computed once so the memo'd spot row sees a plain boolean (#843).
  const spotStale = !!(seg === 'spot' && state?.byApp.spot.status === 'stale');

  // Cards view (#842): the same top entries as the Table, drawn as cards. The
  // chip comes from the live summary, so a stale card (no live numbers) has none.
  const cardItems: PortfolioCardItem[] = top.map((entry) => {
    if (entry.kind === 'spot') {
      const stale = state?.byApp.spot.status === 'stale';
      return {
        key: `spot:${entry.row.chain}`,
        name: 'Spot',
        mark: { uri: null, letter: 'S' },
        color: tokens.walletBrand.spot,
        state: stale ? 'stale' : 'ok',
        value: entry.row.valueUsd === null ? NO_DATA : formatUsd(entry.row.valueUsd),
        chip: null,
        chipNegative: false,
        age: ageLabel(state?.byApp.spot.asOf ?? null),
        accessibilityLabel: 'Open Spot',
        onOpen: openSpotRow,
        onRetry: retry,
        spinner: loading && stale ? <RetrySpinner /> : null,
      };
    }
    const name = APP_NAME[entry.appKey];
    const failed = entry.kind === 'appError';
    const stale = entry.kind === 'app' && entry.stale;
    const pnl = !stale && display ? portfolioCardPnl(display, entry.appKey) : null;
    return {
      key: `app:${entry.appKey}`,
      name,
      mark: { xml: APP_MARK_SVG[entry.appKey] },
      color: tokens.walletBrand[entry.appKey],
      state: failed ? 'error' : stale ? 'stale' : 'ok',
      value: entry.kind === 'app' ? formatUsd(entry.row.valueUsd) : '',
      chip: pnlChipText(pnl),
      chipNegative: pnl !== null && pnl < 0,
      age: ageLabel(state?.byApp[entry.appKey].asOf ?? null),
      accessibilityLabel: `Open ${name} portfolio`,
      onOpen: () => openAppRow(entry.appKey),
      onRetry: retry,
      spinner: loading && (failed || stale) ? <RetrySpinner /> : null,
    };
  });

  // Map view (#871): the same top entries as the Table drawn as treemap
  // tiles — a failed app has no tile, the "+N more" sum is the frame's dim
  // "Other N" tile with no tap. A stale app keeps its last-value tile unmarked,
  // and the layout drops a 0 value, so a Spot value unknown yet draws
  // nothing. Names follow the rows: APP_NAME, "Spot · Solana" (v1 lists
  // Solana only, #770), "Other N".
  const mapItems: PortfolioMapItem[] = [];
  for (const entry of top) {
    if (entry.kind === 'appError') continue;
    if (entry.kind === 'spot') {
      mapItems.push({
        key: `spot:${entry.row.chain}`,
        name: 'Spot · Solana',
        valueUsd: entry.valueUsd,
        valueText: formatUsd(entry.valueUsd),
        other: false,
        accessibilityLabel: 'Open Spot',
        onPress: openSpotRow,
      });
      continue;
    }
    const name = APP_NAME[entry.appKey];
    mapItems.push({
      key: `app:${entry.appKey}`,
      name,
      valueUsd: entry.valueUsd,
      valueText: formatUsd(entry.valueUsd),
      other: false,
      accessibilityLabel: `Open ${name} portfolio`,
      onPress: () => openAppRow(entry.appKey),
    });
  }
  if (moreCount > 0) {
    mapItems.push({
      key: 'other',
      name: `Other ${moreCount}`,
      valueUsd: hiddenSum,
      valueText: formatUsd(hiddenSum),
      other: true,
      accessibilityLabel: `Other ${moreCount} holdings`,
      onPress: null,
    });
  }

  return (
    <View style={styles.section}>
      <View style={styles.headerRow}>
        <Text accessibilityRole="header" style={styles.title}>Portfolio</Text>
        {isMock ? <Text style={styles.demoTag}>demo data</Text> : null}
        <ViewSwitch view={view} onSelect={selectView} />
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
        {view === 'map' ? (
          showSkeletons ? (
            // #871 first load: one skeleton block in place of the box (the
            // frame's .sk.skmap), 260 high, radius 8, nothing spinning.
            <View style={[styles.mapSkeleton, styles.skeleton]} />
          ) : list.length > 0 ? (
            <PortfolioMap items={mapItems} totalUsd={total} />
          ) : null
        ) : view === 'cards' ? (
          <PortfolioCards
            items={cardItems}
            skeleton={showSkeletons}
            moreCount={moreCount}
            moreValue={formatUsd(hiddenSum)}
            onShowAll={() => setShowAll(true)}
          />
        ) : showSkeletons
          ? SKELETON_ROW_KEYS.map((key) => <PortfolioSkeletonRow key={key} />)
          : top.map((entry) => {
          if (entry.kind === 'spot') {
            return (
              <PortfolioSpotRow
                key={`spot:${entry.row.chain}`}
                valueText={entry.row.valueUsd === null ? NO_DATA : formatUsd(entry.row.valueUsd)}
                stale={spotStale}
                // The freshness label ticks with the 30s age tick, so this
                // string — not the row object — is what invalidates the memo.
                ageText={ageLabel(state?.byApp.spot.asOf ?? null)}
                spin={loading}
                retry={retry}
                onPress={openSpotRow}
              />
            );
          }
          if (entry.kind === 'appError') {
            return (
              <PortfolioAppErrorRow key={`err:${entry.appKey}`} appKey={entry.appKey} spin={loading} retry={retry} />
            );
          }
          return (
            <PortfolioAppRow
              key={`app:${entry.appKey}`}
              appKey={entry.appKey}
              summaryLine={entry.row.summaryLine}
              valueText={formatUsd(entry.row.valueUsd)}
              stale={entry.stale}
              // The freshness label ticks with the 30s age tick, so this
              // string — not the row object — is what invalidates the memo.
              ageText={ageLabel(state?.byApp[entry.appKey].asOf ?? null)}
              spin={loading}
              onOpen={openAppRow}
              retry={retry}
            />
          );
        })}
        {display !== null && list.length === 0 && !showSkeletons ? (
          <Text style={styles.failLine}>{seg === 'spot' ? 'No spot holdings yet.' : 'No app balances yet.'}</Text>
        ) : null}
        {moreCount > 0 && view !== 'cards' ? (
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

/**
 * One table row, memo'd on its data only (#843): while the sheet is dragged
 * nothing here re-renders, and a refresh or the age tick that lands
 * mid-drag re-renders just the rows whose own displayed values changed.
 * The press handlers are the section's stable dispatchers, so a row's
 * props stay primitives or stable identity.
 *
 * One Spot chain row (#770): the segment lists one row per chain, labelled
 * "Spot", and the tap opens `/spot` (#844 moves it to the token list). A
 * stale value is dimmed and keeps its age with the same Retry the app rows
 * show (#863) — one stale rule, retried through the whole-summary refetch.
 */
const PortfolioSpotRow = memo(function PortfolioSpotRow({
  valueText,
  stale,
  spin,
  ageText,
  retry,
  onPress,
}: {
  valueText: string;
  stale: boolean;
  spin: boolean;
  ageText: string;
  retry: () => void;
  onPress: () => void;
}) {
  return (
    <View style={styles.row}>
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel="Open Spot"
        style={({ pressed }) => [styles.rowMain, pressed && styles.rowPressed]}
      >
        <View style={styles.nameCol}>
          <Text numberOfLines={1} style={[styles.name, { color: tokens.walletBrand.spot }]}>
            Spot
          </Text>
        </View>
        <View style={styles.valueCol}>
          <Text style={[styles.value, stale && styles.rowStaleValue]}>{valueText}</Text>
          {stale ? (
            <View style={styles.ageRow}>
              {/* Only the failed venue spins while the (single) summary call
                  is in flight — #778 review note 3. */}
              {spin ? <RetrySpinner /> : null}
              <Text style={styles.ageLabel}>{ageText}</Text>
            </View>
          ) : null}
        </View>
      </Pressable>
      {stale ? (
        <View style={styles.retryCol}>
          <Pressable
            onPress={retry}
            accessibilityRole="button"
            accessibilityLabel="Retry Spot"
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
});

const PortfolioAppErrorRow = memo(function PortfolioAppErrorRow({
  appKey,
  spin,
  retry,
}: {
  appKey: PortfolioAppKey;
  spin: boolean;
  retry: () => void;
}) {
  const name = APP_NAME[appKey];
  return (
    <View style={styles.row}>
      <View style={[styles.rowMain, styles.nameCol]}>
        <Text numberOfLines={1} style={[styles.name, { color: tokens.walletBrand[appKey] }]}>
          {name}
        </Text>
        {/* #862: a failing app row always shows the frame retry line. */}
        <Text numberOfLines={1} style={styles.failLine}>
          {"Couldn't load · the rest are fine"}
        </Text>
      </View>
      {spin ? <RetrySpinner /> : null}
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
});

const PortfolioAppRow = memo(function PortfolioAppRow({
  appKey,
  summaryLine,
  valueText,
  stale,
  ageText,
  spin,
  onOpen,
  retry,
}: {
  appKey: PortfolioAppKey;
  summaryLine: string;
  valueText: string;
  stale: boolean;
  ageText: string;
  spin: boolean;
  onOpen: (appKey: PortfolioAppKey) => void;
  retry: () => void;
}) {
  const name = APP_NAME[appKey];
  return (
    <View style={styles.row}>
      <Pressable
        onPress={() => onOpen(appKey)}
        accessibilityRole="button"
        accessibilityLabel={`Open ${name} portfolio`}
        style={({ pressed }) => [styles.rowMain, pressed && styles.rowPressed]}
      >
        <View style={styles.nameCol}>
          <Text numberOfLines={1} style={[styles.name, { color: tokens.walletBrand[appKey] }]}>
            {name}
          </Text>
          {/* The design's second summary line (Cash/Bets/P&L, Equity/open/P&L,
              Pools/unclaimed — frame "Slide-up expanded"). */}
          <Text numberOfLines={1} style={styles.line}>{summaryLine}</Text>
        </View>
        <View style={styles.valueCol}>
          <Text style={[styles.value, stale && styles.rowStaleValue]}>{valueText}</Text>
          {stale ? (
            <View style={styles.ageRow}>
              {/* Only failed rows spin while the (single) summary call is in
                  flight — #778 review note 3; healthy rows never do. */}
              {spin ? <RetrySpinner /> : null}
              <Text style={styles.ageLabel}>{ageText}</Text>
            </View>
          ) : null}
        </View>
      </Pressable>
      {stale ? (
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
});

/** One #858 loading row, as the frame's skRow draws it: a square icon block,
 * two text bars on the left and two short bars on the right — never a spinner. */
const PortfolioSkeletonRow = memo(function PortfolioSkeletonRow() {
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
});

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

/**
 * The Table | Map | Cards switch from the design's ".vs" (wallet.html at
 * 02b98eba, frame "Portfolio · Map"; PROTO_NOTES: "34×28 buttons, on
 * #0E3A4C + gold icon", space-between against the ".ph" title). Cards
 * joined in #842 and Map in #871, so all three are live; a view not in
 * `ENABLED_PORTFOLIO_VIEWS` is dimmed and inert (the choice can only be an
 * enabled view, and it is remembered through `portfolio-view`).
 */
function ViewSwitch({ view, onSelect }: { view: PortfolioView; onSelect: (next: PortfolioView) => void }) {
  const views: readonly PortfolioView[] = ['table', 'map', 'cards'];
  return (
    <View accessibilityRole="tablist" accessibilityLabel="Portfolio view" style={styles.vs}>
      {views.map((next) => {
        const enabled = ENABLED_PORTFOLIO_VIEWS.includes(next);
        const selected = view === next;
        return (
          <Pressable
            key={next}
            accessibilityRole="tab"
            accessibilityLabel={`${next} view`}
            accessibilityState={{ selected, disabled: !enabled }}
            disabled={!enabled}
            onPress={() => onSelect(next)}
            hitSlop={4}
            style={[styles.vsButton, selected && styles.vsButtonOn]}
          >
            <ViewGlyph view={next} selected={selected} dimmed={!enabled} />
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * One 16px glyph per view, drawn like the design's ic('table' | 'map' |
 * 'cards', 16): three rules for table, a tall tile beside two stacked tiles
 * for map (the treemap), a 2×2 grid for cards — stroke 1.8 at 24px scales
 * to 1.2 here.
 */
function ViewGlyph({ view, selected, dimmed }: { view: PortfolioView; selected: boolean; dimmed: boolean }) {
  const tone: 'on' | 'idle' | 'dimmed' = selected ? 'on' : dimmed ? 'dimmed' : 'idle';
  if (view === 'table') {
    return (
      <View style={styles.glyph}>
        <View style={[styles.glyphRule, GLYPH_TONE[tone].rule, { top: 3.5 }]} />
        <View style={[styles.glyphRule, GLYPH_TONE[tone].rule, { top: 8 }]} />
        <View style={[styles.glyphRule, GLYPH_TONE[tone].rule, { top: 12.5 }]} />
      </View>
    );
  }
  if (view === 'map') {
    return (
      <View style={styles.glyph}>
        <View style={[styles.glyphTile, GLYPH_TONE[tone].tile, { left: 2, top: 2.7, width: 6.7, height: 10.7 }]} />
        <View style={[styles.glyphTile, GLYPH_TONE[tone].tile, { left: 8.7, top: 2.7, width: 5.3, height: 6 }]} />
        <View style={[styles.glyphTile, GLYPH_TONE[tone].tile, { left: 8.7, top: 8.7, width: 5.3, height: 4.7 }]} />
      </View>
    );
  }
  return (
    <View style={styles.glyph}>
      <View style={[styles.glyphTile, GLYPH_TONE[tone].tile, { left: 2, top: 2.7, width: 5.3, height: 4.7 }]} />
      <View style={[styles.glyphTile, GLYPH_TONE[tone].tile, { left: 8.7, top: 2.7, width: 5.3, height: 4.7 }]} />
      <View style={[styles.glyphTile, GLYPH_TONE[tone].tile, { left: 2, top: 8.7, width: 5.3, height: 4.7 }]} />
      <View style={[styles.glyphTile, GLYPH_TONE[tone].tile, { left: 8.7, top: 8.7, width: 5.3, height: 4.7 }]} />
    </View>
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
  // Design ".vs" (issue #840): card-coloured track on --bg, 2px padding,
  // hairline edge, pushed to the header row's right end like the mock.
  vs: {
    flexDirection: 'row',
    gap: 2,
    marginLeft: 'auto',
    alignSelf: 'center',
    padding: 2,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(24,90,112,0.78)',
    backgroundColor: tokens.colors.ground,
  },
  vsButton: {
    width: 34,
    height: 28,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Design ".vs .on": #0E3A4C with a gold icon (not a token yet).
  vsButtonOn: { backgroundColor: '#0E3A4C' },
  glyph: { width: 16, height: 16 },
  glyphRule: { position: 'absolute', left: 2, width: 12, height: 1.2, borderRadius: 1 },
  glyphTile: { position: 'absolute', borderWidth: 1.2 },
  table: { gap: 0 },
  // #871: the frame's .sk.skmap first-load block in place of the Map box.
  mapSkeleton: { height: 260, borderRadius: 8 },
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

/** Glyph strokes for the ".vs" segments: on = gold, idle = dim, dimmed = faint. */
const GLYPH_TONE = {
  on: { rule: { backgroundColor: tokens.colors.accent }, tile: { borderColor: tokens.colors.accent } },
  idle: { rule: { backgroundColor: semantic.text.dim }, tile: { borderColor: semantic.text.dim } },
  dimmed: { rule: { backgroundColor: semantic.text.faint }, tile: { borderColor: semantic.text.faint } },
} as const;
