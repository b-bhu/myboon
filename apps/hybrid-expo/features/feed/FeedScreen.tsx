import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FeedHeader } from './components/FeedHeader';
import { FeedList } from './components/FeedList';
import { NarrativeSheet, type NarrativeSheetItem } from './components/NarrativeSheet';
import { FeedSectionState } from './components/feed-section-state';
import { feedItemDetail } from './feed.api';
import { FEED_COLORS as color } from './feed.constants';
import { FEED_TOKENS } from './feed-design';
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
  const openReport = (item: FeedItem) => setSheetItem(feedItemDetail(item));
  return <View style={[styles.screen, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
    <FeedHeader />
    <FeedList items={pages.items} onCardPress={openReport} refreshing={pages.loading && pages.items.length > 0}
      onRefresh={() => { void pages.refresh(); }} onEndReached={() => { if (!pages.olderError) void pages.loadMore(); }} loadingMore={pages.loadingMore}
      header={<View style={styles.header}>
        {pages.error && pages.items.length ? <FeedSectionState title="Refresh unavailable" text="Your loaded reports are still available." onRetry={() => { void pages.refresh(); }} /> : null}
      </View>}
      empty={pages.loading && !pages.items.length ? <UpdatesListSkeleton /> : (
        <FeedSectionState
          title={pages.error ? 'Updates unavailable' : 'No published updates yet'}
          text={pages.error ?? undefined}
          onRetry={pages.error ? () => { void pages.refresh(); } : undefined}
        />
      )}
      footer={pages.olderError ? <FeedSectionState title="Older updates unavailable" text={pages.olderError} onRetry={() => { void pages.loadMore(); }} /> : null}
    />
    <NarrativeSheet item={sheetItem} onClose={() => setSheetItem(null)} />
  </View>;
}

/**
 * First-load skeleton for the updates list (#797): a day header and the
 * bordered cards of the real rows, the same sizes, so nothing jumps when the
 * list lands.
 */
function UpdatesListSkeleton() {
  return <View style={skeletonStyles.list}>
    <View style={skeletonStyles.day} />
    <View style={skeletonStyles.card}>
      <View style={[skeletonStyles.line, skeletonStyles.title]} />
      <View style={[skeletonStyles.line, skeletonStyles.summary]} />
      <View style={[skeletonStyles.line, skeletonStyles.meta]} />
    </View>
    <View style={skeletonStyles.card}>
      <View style={[skeletonStyles.line, skeletonStyles.title]} />
      <View style={[skeletonStyles.line, skeletonStyles.summary]} />
      <View style={[skeletonStyles.line, skeletonStyles.meta]} />
    </View>
  </View>;
}
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.screen }, header: { paddingBottom: 12, gap: 12 },
});
const skeletonStyles = StyleSheet.create({
  list: { marginTop: 8 },
  day: { height: 14, width: 72, borderRadius: 4, marginTop: 8, marginBottom: 8, backgroundColor: color.borderSoft },
  card: { minHeight: 92, borderRadius: 8, borderWidth: 1, borderColor: FEED_TOKENS.colors.border, backgroundColor: FEED_TOKENS.colors.ground, padding: 12, gap: 10, marginBottom: 12 },
  line: { height: 12, borderRadius: 4, backgroundColor: color.borderSoft },
  title: { height: 18, width: '76%' },
  summary: { width: '88%' },
  meta: { width: 92 },
});
