/**
 * Generic screen for local-search venues (Pacifica, Phoenix, Orca, and any
 * future venue registered with the same `search.mode === 'local'` shape).
 * Looks the adapter up in the registry and renders it through `<MarketList>`.
 * This is the payoff of the adapter contract: a new local-search venue is a
 * registry entry, not a new screen. See
 * docs/modules/wallet/PRDs/2026_08_11_token_identity_and_venue_adapters_PRD.md,
 * Sequencing steps 3 and 5.
 *
 * Ownership boundary mirrors `<MarketList>`'s: this screen owns fetching,
 * in-memory filtering/sorting and identity resolution for its adapter.
 * Identity resolution is non-blocking — `useTokenIdentities` renders
 * immediately with whatever's cached (often empty) and the rows re-render
 * once identities land in the background.
 */

import { useRouter, type Href } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppProfileButton } from '@/components/AppProfileButton';
import { AppTopBar, AppTopBarLogo } from '@/components/AppTopBar';
import { MarketList } from '@/features/markets/MarketList';
import { venueRegistry } from '@/features/markets/venue.registry';
import { useTokenIdentities } from '@/lib/token-identity';
import { useWallet } from '@/hooks/useWallet';
import { semantic } from '@/theme';
import { StyleSheet } from 'react-native';

import type { MarketListRow } from '@/features/markets/venue.contract';

export interface VenueMarketListScreenProps {
  venueId: string;
}

export function VenueMarketListScreen({ venueId }: VenueMarketListScreenProps) {
  const adapter = venueRegistry.get(venueId);

  const router = useRouter();
  const insets = useSafeAreaInsets();
  const wallet = useWallet();

  const [markets, setMarkets] = useState<unknown[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [searchText, setSearchText] = useState('');

  const loadMarkets = useCallback(async (showLoading = true) => {
    if (!adapter) return;
    if (showLoading) setLoading(true);
    setErrorMessage(null);
    try {
      const page = await adapter.listMarkets({});
      setMarkets([...page.items]);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : `${adapter.displayName} unavailable`);
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [adapter]);

  useEffect(() => {
    void loadMarkets();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload when the venue itself changes
  }, [venueId]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadMarkets(false);
    setRefreshing(false);
  }, [loadMarkets]);

  const identityRefs = useMemo(
    () => (adapter ? adapter.identityRefs(markets) : []),
    [adapter, markets],
  );
  const identities = useTokenIdentities(identityRefs);

  const filteredMarkets = useMemo(() => {
    if (!adapter) return [];
    const query = searchText.trim();
    const filtered = query && adapter.matchesQuery
      ? markets.filter((market) => adapter.matchesQuery!(market, query))
      : markets;
    return filtered;
  }, [adapter, markets, searchText]);

  const rows: MarketListRow[] = useMemo(() => {
    if (!adapter) return [];
    const mapped = filteredMarkets.map((market) => adapter.toRow(market, identities));
    return adapter.sortRows ? adapter.sortRows(mapped, filteredMarkets) : mapped;
  }, [adapter, filteredMarkets, identities]);

  const onPressRow = useCallback((row: MarketListRow) => {
    router.push(row.href as Href);
  }, [router]);

  const openProfile = useCallback(() => {
    if (!adapter) return;
    router.push(`${adapter.routeBase}/profile` as Href);
  }, [adapter, router]);

  if (!adapter) {
    return null;
  }

  const hasQuery = searchText.trim().length > 0;

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <AppTopBar
        left={<AppTopBarLogo />}
        right={
          <AppProfileButton
            onPress={openProfile}
            connected={wallet.connected}
            label={`Open ${adapter.displayName} profile`}
            hint={`View your ${adapter.displayName} trading account`}
          />
        }
      />

      <MarketList
        rows={rows}
        columns={adapter.columns}
        theme={adapter.theme}
        loading={loading}
        refreshing={refreshing}
        onRefresh={onRefresh}
        error={errorMessage ? { message: errorMessage, onRetry: () => void loadMarkets() } : undefined}
        empty={!errorMessage ? { searching: hasQuery, onReset: hasQuery ? () => setSearchText('') : undefined } : undefined}
        searchBar={{
          value: searchText,
          onChange: setSearchText,
          placeholder: adapter.search.placeholder,
          resultCount: rows.length,
          totalCount: markets.length,
        }}
        onPressRow={onPressRow}
        displayName={adapter.displayName}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: semantic.background.screen,
  },
});
