/**
 * The shared market list shell — table header, row rendering, loading /
 * error / empty states, pull-to-refresh, and the optional bottom search
 * bar. Replaces the ~85%-byte-identical bodies of PacificaMarketListScreen
 * and PhoenixMarketListScreen, and is what MeteoraPoolsScreen's row list
 * renders through too (Meteora keeps its own header/filter chips/sort sheet
 * via the `header` slot — those aren't part of the row list itself). See
 * docs/modules/wallet/PRDs/2026_08_11_token_identity_and_venue_adapters_PRD.md,
 * "Shared market list shell".
 *
 * Loading skeleton, the failure card, and the empty-state card are ported
 * from Meteora's PoolsSkeleton / PoolsFailure / PoolsEmpty
 * (MeteoraPoolsScreen.tsx:528-601) — the best-designed states of the three
 * screens being replaced. The active-sort table-heading highlight is ported
 * from Meteora's `tableHeadingActive` (:930) so an adapter's active column
 * (`ColumnSpec.active`) is actually visible everywhere, not just Meteora.
 *
 * Ownership boundary: this component NEVER fetches, debounces, or
 * paginates. It only renders `rows` and calls the callbacks it's given.
 * Perps filters ~50 rows in memory; Meteora runs a debounced server query
 * with a request-id race guard — both stay entirely in the adapter/screen
 * layer. Identity resolution is likewise the caller's job: rows render
 * immediately with whatever `TokenIdentity` data the row model already
 * carries (via `MarketLead`), including none on first paint.
 */

import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { memo, useMemo, type ReactNode } from 'react';
import {
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ListRenderItemInfo,
} from 'react-native';

import { TokenIcon, TokenPairIcon } from '@/components/TokenIcon';
import type {
  Cell,
  CellTone,
  ColumnSpec,
  MarketListRow,
  MarketListTheme,
} from '@/features/markets/venue.contract';
import { DEFAULT_MARKET_LIST_THEME } from '@/features/markets/venue.theme';
import { tokens } from '@/theme';

export interface MarketListSearchBar {
  value: string;
  onChange: (text: string) => void;
  placeholder: string;
  resultCount?: number;
  totalCount?: number;
}

export interface MarketListError {
  message: string;
  onRetry: () => void;
}

export interface MarketListEmpty {
  searching: boolean;
  onReset?: () => void;
}

export interface MarketListProps {
  rows: MarketListRow[];
  columns: [ColumnSpec, ColumnSpec, ColumnSpec];
  theme?: MarketListTheme;
  loading: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  error?: MarketListError;
  empty?: MarketListEmpty;
  searchBar?: MarketListSearchBar | null;
  header?: ReactNode;
  footer?: ReactNode;
  onEndReached?: () => void;
  onPressRow: (row: MarketListRow) => void;
  displayName: string;
}

const SKELETON_ROWS = [0, 1, 2, 3, 4, 5];

export function MarketList({
  rows,
  columns,
  theme = DEFAULT_MARKET_LIST_THEME,
  loading,
  refreshing,
  onRefresh,
  error,
  empty,
  searchBar,
  header,
  footer,
  onEndReached,
  onPressRow,
  displayName,
}: MarketListProps) {
  const styles = useMemo(() => makeStyles(theme), [theme]);

  const renderItem = useMemo(
    () =>
      ({ item }: ListRenderItemInfo<MarketListRow>) => (
        <MarketRow row={item} styles={styles} theme={theme} onPress={onPressRow} />
      ),
    [styles, theme, onPressRow],
  );

  const keyExtractor = useMemo(() => (row: MarketListRow) => row.key, []);

  const listData = loading ? [] : rows;

  const listEmptyComponent = loading ? (
    <MarketListSkeleton styles={styles} />
  ) : error ? (
    <MarketListFailure styles={styles} theme={theme} displayName={displayName} error={error} />
  ) : empty ? (
    <MarketListEmptyState styles={styles} theme={theme} empty={empty} />
  ) : null;

  return (
    <View style={styles.container}>
      <View style={styles.tableHeader}>
        {columns.map((column, index) => (
          <Text
            key={column.key}
            style={[
              styles.th,
              index === 0 ? styles.thLead : styles.thRight,
              { width: index === 0 ? undefined : column.width },
              index === 0 && styles.thLeadFlex,
              column.active && styles.thActive,
            ]}
          >
            {column.label}
          </Text>
        ))}
      </View>

      <FlatList
        data={listData}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        style={styles.list}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[
          styles.listContent,
          listData.length === 0 && styles.listContentEmpty,
        ]}
        ListHeaderComponent={header as React.ReactElement | undefined}
        ListFooterComponent={footer as React.ReactElement | undefined}
        ListEmptyComponent={listEmptyComponent ?? undefined}
        onEndReached={onEndReached}
        onEndReachedThreshold={0.4}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={theme.accent}
            colors={[theme.accent]}
          />
        }
      />

      {searchBar ? <MarketListSearchBarView styles={styles} theme={theme} searchBar={searchBar} /> : null}
    </View>
  );
}

const MarketRow = memo(function MarketRow({
  row,
  styles,
  theme,
  onPress,
}: {
  row: MarketListRow;
  styles: Styles;
  theme: MarketListTheme;
  onPress: (row: MarketListRow) => void;
}) {
  return (
    <Pressable
      onPress={() => onPress(row)}
      accessibilityRole="button"
      accessibilityLabel={row.a11yLabel}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      <RowLead lead={row.lead} styles={styles} />

      <View style={styles.titleColumn}>
        <Text style={styles.title} numberOfLines={1}>
          {row.title}
          {row.titleSuffix ? <Text style={styles.titleSuffix}> {row.titleSuffix}</Text> : null}
        </Text>
        {row.subtitle ? (
          <Text style={styles.subtitle} numberOfLines={1}>
            {row.subtitle}
          </Text>
        ) : null}
      </View>

      {row.cells.map((cell, index) => (
        <RowCell key={index} cell={cell} styles={styles} theme={theme} />
      ))}
    </Pressable>
  );
});

function RowLead({ lead, styles }: { lead: MarketListRow['lead']; styles: Styles }) {
  if (lead.kind === 'pair') {
    return (
      <View style={styles.leadSlot}>
        <TokenPairIcon
          x={{ venueIconUrl: lead.x.venueIconUrl, letter: lead.x.letter, tint: lead.x.tint }}
          y={{ venueIconUrl: lead.y.venueIconUrl, letter: lead.y.letter, tint: lead.y.tint }}
        />
      </View>
    );
  }

  return (
    <View style={styles.leadSlot}>
      <TokenIcon venueIconUrl={lead.venueIconUrl} letter={lead.letter} />
    </View>
  );
}

function RowCell({ cell, styles, theme }: { cell: Cell; styles: Styles; theme: MarketListTheme }) {
  return (
    <Text
      style={[styles.cell, { width: cell.width }, toneStyle(cell.tone, theme)]}
      numberOfLines={1}
    >
      {cell.text}
    </Text>
  );
}

function toneStyle(tone: CellTone | undefined, theme: MarketListTheme) {
  switch (tone) {
    case 'pos':
      return { color: theme.pos };
    case 'neg':
      return { color: theme.neg };
    case 'dim':
      return { color: theme.textDim };
    case 'neutral':
    default:
      return { color: theme.text };
  }
}

function MarketListSkeleton({ styles }: { styles: Styles }) {
  return (
    <View style={styles.skeletonStack}>
      {SKELETON_ROWS.map((item) => (
        <View key={item} style={styles.skeletonRow}>
          <View style={styles.skeletonToken} />
          <View style={styles.skeletonCopy}>
            <View style={styles.skeletonTitle} />
            <View style={styles.skeletonMeta} />
          </View>
          <View style={styles.skeletonValue} />
          <View style={styles.skeletonValue} />
          <View style={styles.skeletonValueWide} />
        </View>
      ))}
    </View>
  );
}

function MarketListFailure({
  styles,
  theme,
  displayName,
  error,
}: {
  styles: Styles;
  theme: MarketListTheme;
  displayName: string;
  error: MarketListError;
}) {
  return (
    <View style={styles.stateCard}>
      <View style={styles.stateIcon}>
        <MaterialIcons name="cloud-off" size={23} color={theme.neg} />
      </View>
      <Text style={styles.stateTitle}>{`${displayName} unavailable`}</Text>
      <Text style={styles.stateText}>{error.message}</Text>
      <Pressable
        onPress={error.onRetry}
        style={styles.stateButton}
        accessibilityRole="button"
        accessibilityLabel={`Try loading ${displayName} again`}
      >
        <Text style={styles.stateButtonText}>Try again</Text>
      </Pressable>
    </View>
  );
}

function MarketListEmptyState({
  styles,
  theme,
  empty,
}: {
  styles: Styles;
  theme: MarketListTheme;
  empty: MarketListEmpty;
}) {
  return (
    <View style={styles.stateCard}>
      <View style={styles.stateIcon}>
        <MaterialIcons name="search-off" size={23} color={theme.accent} />
      </View>
      <Text style={styles.stateTitle}>
        {empty.searching ? 'No matching markets' : 'No markets available'}
      </Text>
      <Text style={styles.stateText}>
        {empty.searching
          ? 'Try another search term.'
          : 'This venue has not returned any markets.'}
      </Text>
      {empty.searching && empty.onReset ? (
        <Pressable
          onPress={empty.onReset}
          style={styles.stateButton}
          accessibilityRole="button"
          accessibilityLabel="Reset market search"
        >
          <Text style={styles.stateButtonText}>Reset search</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function MarketListSearchBarView({
  styles,
  theme,
  searchBar,
}: {
  styles: Styles;
  theme: MarketListTheme;
  searchBar: MarketListSearchBar;
}) {
  const { value, onChange, placeholder, resultCount, totalCount } = searchBar;
  const showCount = value.length > 0 && resultCount !== undefined && totalCount !== undefined;

  return (
    <View style={styles.searchBar}>
      <MaterialIcons name="search" size={16} color={theme.textDim} />
      <TextInput
        style={styles.searchInput}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={theme.textFaint}
        autoCapitalize="characters"
        autoCorrect={false}
        accessibilityLabel={placeholder}
      />
      {value.length > 0 && (
        <Pressable
          onPress={() => onChange('')}
          hitSlop={8}
          style={styles.searchClear}
          accessibilityRole="button"
          accessibilityLabel="Clear search"
        >
          <MaterialIcons name="close" size={14} color={theme.textDim} />
        </Pressable>
      )}
      {showCount && (
        <Text style={styles.marketCount}>
          {resultCount}/{totalCount}
        </Text>
      )}
    </View>
  );
}

const COL_LEAD = 40;

function makeStyles(theme: MarketListTheme) {
  return StyleSheet.create({
    container: {
      flex: 1,
    },
    list: {
      flex: 1,
    },
    listContent: {
      paddingTop: 0,
    },
    listContentEmpty: {
      flexGrow: 1,
    },

    // Table header
    tableHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: tokens.spacing.lg,
      paddingVertical: tokens.spacing.sm,
      borderBottomWidth: 1,
      borderBottomColor: theme.border,
      backgroundColor: theme.screen,
    },
    th: {
      fontFamily: 'monospace',
      fontSize: tokens.fontSize.xxs,
      letterSpacing: 1.2,
      textTransform: 'uppercase',
      color: theme.textFaint,
    },
    thLead: {
      flex: 1,
    },
    thLeadFlex: {
      flex: 1,
    },
    thRight: {
      textAlign: 'right',
    },
    thActive: {
      color: theme.accent,
    },

    // Row
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: tokens.spacing.lg,
      paddingVertical: tokens.spacing.md + 2,
      borderBottomWidth: 1,
      borderBottomColor: theme.rowDivider,
    },
    rowPressed: {
      backgroundColor: theme.rowPressed,
    },
    leadSlot: {
      marginRight: tokens.spacing.sm,
    },
    titleColumn: {
      flex: 1,
      minWidth: 0,
    },
    title: {
      fontFamily: 'monospace',
      fontSize: tokens.fontSize.md,
      fontWeight: '700',
      color: theme.text,
      letterSpacing: 0.2,
    },
    titleSuffix: {
      fontSize: tokens.fontSize.xs,
      fontWeight: '400',
      color: theme.textFaint,
    },
    subtitle: {
      fontFamily: 'monospace',
      fontSize: tokens.fontSize.xxs,
      color: theme.textFaint,
      marginTop: 2,
    },
    cell: {
      fontFamily: 'monospace',
      fontSize: tokens.fontSize.sm,
      fontWeight: '600',
      textAlign: 'right',
      color: theme.text,
    },

    // Skeleton
    skeletonStack: {
      gap: 1,
    },
    skeletonRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: tokens.spacing.lg,
      paddingVertical: tokens.spacing.md + 2,
      borderBottomWidth: 1,
      borderBottomColor: theme.rowDivider,
    },
    skeletonToken: {
      width: COL_LEAD,
      height: 28,
      borderRadius: 14,
      backgroundColor: theme.surfaceLift,
      marginRight: tokens.spacing.sm,
    },
    skeletonCopy: {
      flex: 1,
      gap: 7,
    },
    skeletonTitle: {
      width: '62%',
      height: 11,
      borderRadius: 4,
      backgroundColor: theme.surfaceLift,
    },
    skeletonMeta: {
      width: '38%',
      height: 8,
      borderRadius: 4,
      backgroundColor: theme.surfaceLift,
    },
    skeletonValue: {
      width: 58,
      height: 12,
      borderRadius: 4,
      backgroundColor: theme.surfaceLift,
    },
    skeletonValueWide: {
      width: 62,
      height: 12,
      borderRadius: 5,
      backgroundColor: theme.surfaceLift,
    },

    // State cards (error / empty)
    stateCard: {
      flex: 1,
      minHeight: 260,
      alignItems: 'center',
      justifyContent: 'center',
      padding: 28,
    },
    stateIcon: {
      width: 48,
      height: 48,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 24,
      backgroundColor: theme.surface,
      marginBottom: 14,
    },
    stateTitle: {
      color: theme.text,
      fontSize: 18,
      lineHeight: 22,
      fontWeight: '800',
      textAlign: 'center',
    },
    stateText: {
      maxWidth: 280,
      color: theme.textDim,
      fontSize: 13,
      lineHeight: 19,
      textAlign: 'center',
      marginTop: 7,
    },
    stateButton: {
      minHeight: 40,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 20,
      backgroundColor: theme.accent,
      paddingHorizontal: 18,
      marginTop: 16,
    },
    stateButtonText: {
      color: theme.screen,
      fontSize: 12,
      fontWeight: '800',
    },

    // Bottom search bar
    searchBar: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingHorizontal: tokens.spacing.lg,
      paddingVertical: tokens.spacing.sm,
      borderTopWidth: 1,
      borderTopColor: theme.border,
      backgroundColor: theme.surface,
    },
    searchInput: {
      flex: 1,
      fontFamily: 'monospace',
      fontSize: tokens.fontSize.sm,
      color: theme.text,
      padding: 0,
    },
    searchClear: {
      width: 20,
      height: 20,
      borderRadius: 10,
      backgroundColor: theme.surfaceLift,
      alignItems: 'center',
      justifyContent: 'center',
    },
    marketCount: {
      fontFamily: 'monospace',
      fontSize: tokens.fontSize.xxs,
      color: theme.textDim,
      letterSpacing: 0.5,
    },
  });
}

type Styles = ReturnType<typeof makeStyles>;
