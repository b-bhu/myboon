import { useEffect, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CalendarSlide } from './components/CalendarSlide';
import { MarketSlide } from './components/MarketSlide';
import { WalletsSlide } from './components/WalletsSlide';
import { FEED_TOKENS } from './feed-design';

/** Markets now. The three cards already used by the feed open Calendar, Smart wallets and Market. */
export default function MarketsNowScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    if (!refreshing) return undefined;
    const timer = setTimeout(() => setRefreshing(false), 700);
    return () => clearTimeout(timer);
  }, [refreshing, refreshVersion]);

  return (
    <View style={[styles.screen, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <View style={styles.bar}>
        <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()} style={styles.back}>
          <Text style={styles.backGlyph}>‹</Text>
        </Pressable>
        <Text accessibilityRole="header" style={styles.title}>Markets now</Text>
        <View style={styles.back} />
      </View>
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        refreshControl={(
          <RefreshControl
            refreshing={refreshing}
            tintColor={FEED_TOKENS.colors.accent}
            colors={[FEED_TOKENS.colors.accent]}
            onRefresh={() => {
              setRefreshing(true);
              setRefreshVersion((value) => value + 1);
            }}
          />
        )}
      >
        <CalendarSlide active refreshVersion={refreshVersion} />
        <WalletsSlide active refreshVersion={refreshVersion} />
        <MarketSlide active refreshVersion={refreshVersion} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: FEED_TOKENS.colors.screen },
  bar: { height: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16 },
  back: { width: 44, height: 44, alignItems: 'flex-start', justifyContent: 'center' },
  backGlyph: { color: FEED_TOKENS.colors.text, fontSize: 28, lineHeight: 32 },
  title: { color: FEED_TOKENS.colors.text, fontSize: 15, fontWeight: '700' },
  content: { paddingHorizontal: 16, paddingBottom: 16, gap: 16 },
});
