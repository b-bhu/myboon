/**
 * Per-venue portfolio drill-down SHELL (#657, D2).
 *
 * One screen scoped to one venue: account-value hero, always-visible
 * deposit/withdraw when the venue provides them, and the three fixed tabs —
 * Positions · Orders · History — shared by every venue. A venue with no
 * orders shows an empty state, not a different tab set.
 *
 * Venues supply rows and actions, not layout. Rows render through one shared
 * shape (lead | right values + gold venue-action slot); the wording is the
 * adapter's. Tapping a row opens that venue's own pre-filled close/manage
 * flow via row.onPress — the shell never interprets venue actions.
 *
 * Execution lives in the venue adapters, moved from the four retired profile
 * screens; this shell signs nothing and moves nothing. The tab bar and tab
 * body are shared with the Wallet's Polymarket app view (#773).
 */

import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useRouter } from 'expo-router';
import { useMemo, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppTopBar, AppTopBarIconButton, AppTopBarTitle } from '@/components/AppTopBar';
import {
  PORTFOLIO_TAB_KEYS,
  countPortfolioRows,
  isPortfolioTabEmpty,
  portfolioEmptyCopy,
  type PortfolioTabData,
  type PortfolioTabKey,
  type PortfolioRowTone,
  type VenuePortfolioRow,
} from '@/features/portfolio/venue-portfolio.contract';
import { semantic, tokens } from '@/theme';

export type { PortfolioTabKey } from '@/features/portfolio/venue-portfolio.contract';

export type PortfolioVenueId = 'phoenix' | 'pacifica' | 'meteora' | 'polymarket';

const VENUE_LABEL: Record<PortfolioVenueId, string> = {
  phoenix: 'Phoenix',
  pacifica: 'Pacifica',
  meteora: 'Meteora',
  polymarket: 'Polymarket',
};

export interface VenuePortfolioScreenTab extends PortfolioTabData {
  /** Retry for a 'failed' tab (each venue fetch fails on its own). */
  onRetry?: () => void;
  /** Venue override for the shared empty state; null keeps the fallback copy. */
  empty?: { title: string; message: string } | null;
  /** Custom venue nodes above the row sections (e.g. Polymarket redeemables). */
  above?: ReactNode;
  below?: ReactNode;
}

export interface VenuePortfolioScreenProps {
  venueId: PortfolioVenueId;
  hero: {
    /** Caption above the value; defaults to 'Account value'. */
    label?: string;
    value: string;
    loading?: boolean;
    change?: string | null;
    changeTone?: 'pos' | 'neg' | null;
    /** Small note under the change line (e.g. an approximation note). */
    note?: string | null;
  };
  onDeposit?: () => void;
  onWithdraw?: () => void;
  /** Right side of the top bar — Polymarket's settings entry, nothing else. */
  right?: ReactNode;
  tabs: Record<PortfolioTabKey, VenuePortfolioScreenTab>;
  /** Fired when the user switches tabs (e.g. Meteora's lazy history fetch). */
  onTabChange?: (tab: PortfolioTabKey) => void;
  refreshing?: boolean;
  onRefresh?: () => void;
  testID?: string;
}

const EMPTY_ICON: Record<PortfolioTabKey, keyof typeof MaterialIcons.glyphMap> = {
  positions: 'account-balance-wallet',
  orders: 'schedule',
  history: 'history',
};

export function VenuePortfolioScreen({
  venueId,
  hero,
  onDeposit,
  onWithdraw,
  right,
  tabs,
  onTabChange,
  refreshing = false,
  onRefresh,
  testID,
}: VenuePortfolioScreenProps) {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<PortfolioTabKey>('positions');

  const tab = tabs[activeTab];

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]} testID={testID}>
      <AppTopBar
        left={
          <AppTopBarIconButton
            icon="arrow-back"
            onPress={() => router.back()}
            accessibilityLabel="Go back"
          />
        }
        center={
          <View style={styles.titleBlock}>
            <AppTopBarTitle>Portfolio</AppTopBarTitle>
            <View style={styles.venueBadge}>
              <View
                style={[styles.venueDot, { backgroundColor: tokens.walletBrand[venueId] }]}
              />
              <Text style={styles.venueLabel}>{VENUE_LABEL[venueId]}</Text>
            </View>
          </View>
        }
        right={right ?? null}
      />

      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        refreshControl={
          onRefresh ? (
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={semantic.text.accentDim} />
          ) : undefined
        }
      >
        <View style={styles.hero}>
          <Text style={styles.heroLabel}>{hero.label ?? 'Account value'}</Text>
          {hero.loading ? (
            <ActivityIndicator size="small" color={semantic.text.accentDim} />
          ) : (
            <Text style={styles.heroValue}>{hero.value}</Text>
          )}
          {hero.change ? (
            <Text
              style={[
                styles.heroChange,
                hero.changeTone === 'pos' && styles.textPos,
                hero.changeTone === 'neg' && styles.textNeg,
              ]}
            >
              {hero.change}
            </Text>
          ) : null}
          {hero.note ? <Text style={styles.heroNote}>{hero.note}</Text> : null}
        </View>

        {onDeposit || onWithdraw ? (
          <View style={styles.actions}>
            {onDeposit ? (
              <Pressable
                style={({ pressed }) => [styles.actionBtn, styles.actionGold, pressed && styles.pressed]}
                onPress={onDeposit}
                accessibilityRole="button"
                accessibilityLabel="Deposit"
              >
                <Text style={styles.actionGoldText}>Deposit</Text>
              </Pressable>
            ) : null}
            {onWithdraw ? (
              <Pressable
                style={({ pressed }) => [styles.actionBtn, styles.actionGhost, pressed && styles.pressed]}
                onPress={onWithdraw}
                accessibilityRole="button"
                accessibilityLabel="Withdraw"
              >
                <Text style={styles.actionGhostText}>Withdraw</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}

        {/* The three tabs are fixed: rendered for every venue, always in this order. */}
        <PortfolioTabBar
          tabs={tabs}
          activeTab={activeTab}
          onChange={(key) => {
            setActiveTab(key);
            onTabChange?.(key);
          }}
        />

        <PortfolioTabBody tabKey={activeTab} tab={tab} />
      </ScrollView>
    </View>
  );
}

/**
 * The three-tab bar (Positions · Orders · History) with row-count badges,
 * shared by the venue screens and the Wallet's Polymarket app view (#773).
 */
export function PortfolioTabBar({
  tabs,
  activeTab,
  onChange,
}: {
  tabs: Record<PortfolioTabKey, VenuePortfolioScreenTab>;
  activeTab: PortfolioTabKey;
  onChange: (tab: PortfolioTabKey) => void;
}) {
  const counts = useMemo(
    () =>
      Object.fromEntries(
        PORTFOLIO_TAB_KEYS.map((key) => [key, countPortfolioRows(tabs[key])]),
      ) as Record<PortfolioTabKey, number>,
    [tabs],
  );

  return (
    <View style={styles.tabRow} accessibilityRole="tablist">
      {PORTFOLIO_TAB_KEYS.map((key) => (
        <TabButton
          key={key}
          label={key === 'positions' ? 'Positions' : key === 'orders' ? 'Orders' : 'History'}
          count={counts[key]}
          active={activeTab === key}
          onPress={() => onChange(key)}
        />
      ))}
    </View>
  );
}

function TabButton({
  label,
  count,
  active,
  onPress,
}: {
  label: string;
  count: number;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable style={[styles.tab, active && styles.tabActive]} onPress={onPress} accessibilityRole="tab" accessibilityState={{ selected: active }}>
      <Text style={[styles.tabText, active && styles.tabTextActive]}>{label}</Text>
      {count > 0 && (
        <View style={[styles.tabBadge, active && styles.tabBadgeActive]}>
          <Text style={[styles.tabBadgeText, active && styles.tabBadgeTextActive]}>{count}</Text>
        </View>
      )}
    </Pressable>
  );
}

function valueToneStyle(tone?: PortfolioRowTone) {
  switch (tone) {
    case 'pos':
      return styles.textPos;
    case 'neg':
      return styles.textNeg;
    case 'accent':
      return styles.textAccent;
    default:
      return null;
  }
}

export function PortfolioTabBody({
  tabKey,
  tab,
}: {
  tabKey: PortfolioTabKey;
  tab: VenuePortfolioScreenTab;
}) {
  if (tab.status === 'loading' || tab.status === 'idle') {
    return (
      <View style={styles.stateWrap}>
        <ActivityIndicator size="small" color={semantic.text.accentDim} />
      </View>
    );
  }

  if (tab.status === 'failed') {
    return (
      <View style={styles.stateCard}>
        <Text style={styles.stateError}>{tab.error ?? 'Unable to load'}</Text>
        {tab.onRetry ? (
          <Pressable onPress={tab.onRetry} hitSlop={8} accessibilityRole="button" accessibilityLabel="Try again">
            <Text style={styles.stateRetry}>Try again</Text>
          </Pressable>
        ) : null}
      </View>
    );
  }

  if (isPortfolioTabEmpty(tab)) {
    const copy = tab.empty ?? portfolioEmptyCopy(tabKey);
    return (
      <View style={styles.stateCard}>
        <MaterialIcons name={EMPTY_ICON[tabKey]} size={22} color={semantic.text.faint} />
        <Text style={styles.emptyTitle}>{copy.title}</Text>
        <Text style={styles.emptyMessage}>{copy.message}</Text>
      </View>
    );
  }

  return (
    <>
      {tab.above ?? null}
      {tab.sections.map((section) => (
        <View key={section.key} style={styles.section}>
          {section.label ? <Text style={styles.sectionLabel}>{section.label}</Text> : null}
          <View style={styles.card}>
            {section.rows.map((row) => (
              <PortfolioRowView key={row.key} row={row} />
            ))}
          </View>
        </View>
      ))}
      {tab.below ?? null}
    </>
  );
}

export function PortfolioRowView({ row }: { row: VenuePortfolioRow }) {
  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      onPress={row.onPress}
      disabled={!row.onPress}
      accessibilityRole={row.onPress ? 'button' : undefined}
      accessibilityLabel={[row.title, row.subtitle, row.value].filter(Boolean).join(', ')}
    >
      <View style={styles.rowLead}>
        {row.titleAccent ? (
          <Text style={styles.rowTitle}>
            {row.titleAccent} <Text style={styles.rowTitlePlain}>{row.title}</Text>
          </Text>
        ) : (
          <Text style={styles.rowTitlePlain} numberOfLines={1}>
            {row.title}
          </Text>
        )}
        {row.subtitle ? (
          <Text style={styles.rowSubtitle} numberOfLines={1}>
            {row.subtitle}
          </Text>
        ) : null}
      </View>
      <View style={styles.rowRight}>
        <View style={styles.rowValues}>
          <Text style={[styles.rowValue, valueToneStyle(row.valueTone)]} numberOfLines={1}>
            {row.value}
          </Text>
          {row.subValue ? (
            <Text style={[styles.rowSubValue, valueToneStyle(row.subValueTone)]} numberOfLines={1}>
              {row.subValue}
            </Text>
          ) : null}
        </View>
        {row.actionLabel ? (
          <Pressable
            onPress={row.actionDisabled || row.actionPending ? undefined : row.onActionPress}
            disabled={row.actionDisabled || row.actionPending || !row.onActionPress}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={row.actionLabel}
          >
            <Text style={[styles.rowAction, row.actionDisabled && styles.rowActionDisabled]}>
              {row.actionPending ? '…' : row.actionLabel}
            </Text>
          </Pressable>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: semantic.background.screen },
  content: { padding: 14, paddingBottom: 40, gap: 12 },
  titleBlock: { alignItems: 'center', gap: 3 },
  venueBadge: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  venueDot: { width: 7, height: 7, borderRadius: 4 },
  venueLabel: {
    color: semantic.text.dim,
    fontSize: 10,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    fontWeight: '700',
  },
  hero: { gap: 3 },
  heroLabel: {
    color: semantic.text.dim,
    fontSize: 11,
    letterSpacing: 1.1,
    textTransform: 'uppercase',
    fontWeight: '700',
  },
  heroValue: {
    color: semantic.text.primary,
    fontSize: 30,
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
  },
  heroChange: { color: semantic.text.dim, fontSize: 12, fontVariant: ['tabular-nums'] },
  heroNote: { color: semantic.text.faint, fontSize: 11, marginTop: 1 },
  actions: { flexDirection: 'row', gap: 8 },
  actionBtn: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 11,
    borderRadius: 6,
  },
  actionGold: { backgroundColor: tokens.colors.accent },
  actionGoldText: { color: semantic.background.screen, fontSize: 13, fontWeight: '700' },
  actionGhost: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: semantic.border.muted,
    backgroundColor: semantic.background.surface,
  },
  actionGhostText: { color: semantic.text.primary, fontSize: 13, fontWeight: '600' },
  pressed: { opacity: 0.72 },
  tabRow: {
    flexDirection: 'row',
    gap: 6,
    marginTop: 2,
  },
  tab: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 9,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: semantic.border.muted,
    backgroundColor: semantic.background.surface,
  },
  tabActive: { borderColor: tokens.colors.accent, backgroundColor: semantic.background.lift },
  tabText: { color: semantic.text.dim, fontSize: 12, fontWeight: '600' },
  tabTextActive: { color: semantic.text.primary },
  tabBadge: {
    minWidth: 17,
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 8,
    backgroundColor: semantic.background.lift,
    alignItems: 'center',
  },
  tabBadgeActive: { backgroundColor: tokens.colors.accent },
  tabBadgeText: { color: semantic.text.faint, fontSize: 10, fontVariant: ['tabular-nums'] },
  tabBadgeTextActive: { color: semantic.background.screen, fontWeight: '700' },
  stateWrap: { alignItems: 'center', paddingVertical: 36 },
  stateCard: {
    alignItems: 'center',
    gap: 6,
    padding: 20,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: semantic.border.muted,
    backgroundColor: semantic.background.surface,
  },
  stateError: { color: semantic.sentiment.negative, fontSize: 12, textAlign: 'center' },
  stateRetry: { color: tokens.colors.accent, fontSize: 12, fontWeight: '600' },
  emptyTitle: { color: semantic.text.primary, fontSize: 13, fontWeight: '600', textAlign: 'center' },
  emptyMessage: { color: semantic.text.dim, fontSize: 12, textAlign: 'center' },
  section: { gap: 6 },
  sectionLabel: {
    color: semantic.text.faint,
    fontSize: 10,
    letterSpacing: 1,
    textTransform: 'uppercase',
    fontWeight: '700',
  },
  card: {
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: semantic.border.muted,
    backgroundColor: semantic.background.surface,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 11,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: semantic.border.muted,
  },
  rowLead: { flex: 1, gap: 2, flexShrink: 1 },
  rowTitle: { color: semantic.text.primary, fontSize: 13, fontWeight: '700', flexShrink: 1 },
  rowTitlePlain: { color: semantic.text.primary, fontSize: 13, flexShrink: 1 },
  rowSubtitle: { color: semantic.text.faint, fontSize: 11 },
  rowRight: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  rowValues: { alignItems: 'flex-end', gap: 2 },
  rowValue: { color: semantic.text.primary, fontSize: 12, fontVariant: ['tabular-nums'] },
  rowSubValue: { color: semantic.text.faint, fontSize: 11, fontVariant: ['tabular-nums'] },
  rowAction: { color: tokens.colors.accent, fontSize: 12, fontWeight: '700' },
  rowActionDisabled: { color: semantic.text.faint },
  textPos: { color: semantic.sentiment.positive },
  textNeg: { color: semantic.sentiment.negative },
  textAccent: { color: tokens.colors.accent },
});
