import type { ReactElement } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { UpdateRowCard } from '@/features/feed/components/UpdateRow';
import { FEED_TOKENS, monoFontFamily } from '@/features/feed/feed-design';
import { groupUpdatesByDay } from '@/features/feed/feed-updates';
import type { FeedItem } from '@/features/feed/feed.types';

interface FeedListProps {
  items: FeedItem[];
  onCardPress: (item: FeedItem) => void;
  refreshing: boolean;
  onRefresh: () => void;
  onEndReached: () => void;
  loadingMore: boolean;
  header?: ReactElement | null;
  empty?: ReactElement | null;
  footer?: ReactElement | null;
}

export function FeedList({
  items,
  onCardPress,
  refreshing,
  onRefresh,
  onEndReached,
  loadingMore,
  header = null,
  empty = null,
  footer = null,
}: FeedListProps) {
  // One snapshot per render so every row is aged against the same instant.
  const now = new Date();
  const rows = groupUpdatesByDay(items, now);
  return (
    <FlatList
      data={rows}
      keyExtractor={(row) => row.key}
      renderItem={({ item: row }) => (row.kind === 'day'
        ? <Text style={styles.dayLabel}>{row.label.toUpperCase()}</Text>
        : <UpdateRowCard item={row.item} now={now} onPress={onCardPress} />)}
      showsVerticalScrollIndicator={false}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor={FEED_TOKENS.colors.accent}
          colors={[FEED_TOKENS.colors.accent]}
        />
      }
      onEndReached={onEndReached}
      onEndReachedThreshold={0.4}
      ListHeaderComponent={header}
      ListEmptyComponent={empty}
      ListFooterComponent={
        loadingMore ? (
          <View style={styles.footer}>
            <ActivityIndicator size="small" color={FEED_TOKENS.colors.accent} />
          </View>
        ) : footer
      }
    />
  );
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 20,
  },
  dayLabel: {
    paddingTop: 12,
    paddingBottom: 8,
    color: FEED_TOKENS.colors.textFaint,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.label,
    lineHeight: 14,
    fontWeight: '600',
    letterSpacing: 1,
  },
  footer: {
    paddingVertical: 16,
    alignItems: 'center',
  },
});