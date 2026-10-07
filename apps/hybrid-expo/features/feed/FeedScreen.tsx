import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FeedHeader } from './components/FeedHeader';
import { FeedList } from './components/FeedList';
import { NarrativeSheet, type NarrativeSheetItem } from './components/NarrativeSheet';
import { FeedSectionState } from './components/feed-section-state';
import { FEED_COLORS as color } from './feed.constants';
import type { FeedItem } from './feed.types';
import { useReportPages } from './use-report-pages';
import { useFocusedAppStateInterval } from '@/hooks/useFocusedAppStateInterval';

export default function FeedScreen() {
  const pages = useReportPages();
  const insets = useSafeAreaInsets();
  const [sheetItem, setSheetItem] = useState<NarrativeSheetItem | null>(null);
  const [, setClock] = useState(0);
  useFocusedAppStateInterval(() => pages.refresh(true), 5 * 60_000);
  useFocusedAppStateInterval(() => setClock((value) => value + 1), 60_000);
  const openReport = (item: FeedItem) => setSheetItem({ id: item.id, title: item.headline, summary: item.description,
    createdAt: item.createdAt, imageUrl: item.imageUrl, imageKind: item.imageKind, imageAttribution: item.imageAttribution });
  return <View style={[styles.screen, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
    <FeedHeader />
    <FeedList items={pages.items} onCardPress={openReport} refreshing={pages.loading && pages.items.length > 0}
      onRefresh={() => { void pages.refresh(); }} onEndReached={() => { if (!pages.olderError) void pages.loadMore(); }} loadingMore={pages.loadingMore}
      header={<View style={styles.header}>
        <Text style={styles.context}>Published reports · Newest first</Text>
        {pages.error && pages.items.length ? <FeedSectionState title="Refresh unavailable" text="Your loaded reports are still available." onRetry={() => { void pages.refresh(); }} /> : null}
      </View>}
      empty={<FeedSectionState title={pages.loading ? 'Loading updates…' : pages.error ? 'Updates unavailable' : 'No published updates yet'} loading={pages.loading} text={pages.error ?? undefined} onRetry={pages.error ? () => { void pages.refresh(); } : undefined} />}
      footer={pages.olderError ? <FeedSectionState title="Older updates unavailable" text={pages.olderError} onRetry={() => { void pages.loadMore(); }} /> : null}
    />
    {pages.pending ? <Pressable accessibilityRole="button" accessibilityLabel="Apply new report updates" onPress={pages.apply} style={[styles.updates, { bottom: insets.bottom + 12 }]}><Text style={styles.action}>New updates ↓</Text></Pressable> : null}
    <NarrativeSheet item={sheetItem} onClose={() => setSheetItem(null)} />
  </View>;
}
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.screen }, header: { paddingBottom: 12, gap: 12 },
  context: { color: color.textDim, fontSize: 12, lineHeight: 18 },
  updates: { position: 'absolute', left: 16, right: 16, zIndex: 2, minHeight: 44, justifyContent: 'center', alignItems: 'center', borderRadius: 8, borderWidth: 1, borderColor: color.border, backgroundColor: color.card },
  action: { color: color.accent, fontSize: 13, fontWeight: '700' },
});
