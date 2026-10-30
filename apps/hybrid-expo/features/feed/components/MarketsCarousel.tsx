import { Fragment, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import { FEED_TOKENS, monoFontFamily } from '../feed-design';
import { carouselIndex } from '../feed-home';
import { SectionHeader } from './ui/SectionHeader';
import { CalendarSlide } from './CalendarSlide';
import { MarketSlide } from './MarketSlide';
import { WalletsSlide } from './WalletsSlide';

const SLIDES = [
  { key: 'calendar', label: 'CALENDAR' },
  { key: 'wallets', label: 'WALLETS' },
  { key: 'market', label: 'MARKET' },
] as const;

/**
 * "Markets now" paged carousel (feed-mock.html #s-home .bar second section +
 * #s-slides, DESIGN.md §7/§8): three full-width slides — calendar, smart
 * wallets, market — with the mono label row above and the gold bars pager
 * below. All three are redesign cards from #498/#499/#500.
 */
export function MarketsCarousel({ active, refreshVersion }: { active: boolean; refreshVersion: number }) {
  const [slideWidth, setSlideWidth] = useState(0);
  const [current, setCurrent] = useState(0);
  // Pager height follows the visible slide so a short slide leaves no gap.
  const [heights, setHeights] = useState<number[]>([]);
  const measure = (index: number) => (event: { nativeEvent: { layout: { height: number } } }) => {
    const height = event.nativeEvent.layout.height;
    setHeights((prev) => (prev[index] === height ? prev : Object.assign([...prev], { [index]: height })));
  };
  // Same paged pattern as TodayCarousel: full-width slides, one snap per swipe.
  const track = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (slideWidth > 0) setCurrent(carouselIndex(event.nativeEvent.contentOffset.x, slideWidth, SLIDES.length));
  };
  return (
    <View style={styles.section}>
      <SectionHeader title="Markets now" />
      <View style={styles.labels} accessibilityLabel={`Markets slides: calendar, wallets, market. Showing slide ${current + 1} of ${SLIDES.length}`}>
        {SLIDES.map((slide, index) => (
          <Fragment key={slide.key}>
            {index > 0 ? <Text style={styles.labelSep} accessibilityElementsHidden> · </Text> : null}
            <Text style={[styles.label, index === current && styles.labelActive]}>{slide.label}</Text>
          </Fragment>
        ))}
      </View>
      <View
        onLayout={(event) => {
          const width = event.nativeEvent.layout.width;
          if (width > 0) setSlideWidth(width);
        }}
      >
        {slideWidth > 0 ? (
          <>
            <ScrollView
              horizontal
              pagingEnabled
              showsHorizontalScrollIndicator={false}
              scrollEventThrottle={16}
              onScroll={track}
              onMomentumScrollEnd={track}
              style={heights[current] ? { height: heights[current] } : undefined}
              contentContainerStyle={styles.track}
            >
              <View style={{ width: slideWidth }} onLayout={measure(0)}>
                <CalendarSlide active={active} refreshVersion={refreshVersion} />
              </View>
              <View style={{ width: slideWidth }} onLayout={measure(1)}>
                <WalletsSlide active={active} refreshVersion={refreshVersion} />
              </View>
              <View style={{ width: slideWidth }} onLayout={measure(2)}>
                <MarketSlide active={active} refreshVersion={refreshVersion} />
              </View>
            </ScrollView>
            <View style={styles.bars}>
              {SLIDES.map((slide, index) => (
                <View key={slide.key} style={[styles.bar, index === current && styles.barActive]} />
              ))}
            </View>
          </>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    alignItems: 'flex-start',
  },
  section: {
    gap: FEED_TOKENS.space.sm,
  },
  // Mono caps slide-name row (mock #mnl): active name in text colour.
  labels: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: FEED_TOKENS.space.xs,
  },
  label: {
    color: FEED_TOKENS.colors.textDim,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.label,
    letterSpacing: 1,
  },
  labelActive: {
    color: FEED_TOKENS.colors.text,
  },
  labelSep: {
    color: FEED_TOKENS.colors.textDim,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.label,
    letterSpacing: 1,
  },
  // Progress bars (mock #mbars): one flex bar per slide, active one gold.
  bars: {
    flexDirection: 'row',
    gap: FEED_TOKENS.space.xs,
    marginTop: FEED_TOKENS.space.sm,
  },
  bar: {
    flex: 1,
    height: 3,
    borderRadius: 0,
    backgroundColor: FEED_TOKENS.colors.textFaint,
    opacity: 0.5,
  },
  barActive: {
    backgroundColor: FEED_TOKENS.colors.accent,
    opacity: 1,
  },
});