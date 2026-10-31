import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { changeText, formatTokenPrice, marketSample, sampleNews } from '../feed-market';
import type { MarketInterval } from '../feed-market';
import { tokenTradeRoutes } from '../takeAction.routes';
import { FEED_TOKENS, monoFontFamily } from '../feed-design';
import { formatFeedUsd } from '../feed-format';
import { heatmapTone } from '../token-heatmap-layout';
import type { HeatmapToken } from '../token-heatmap.types';
import { FeedSheet } from './ui/FeedSheet';
import { MockOnly } from './ui/SampleDataLabel';

interface TokenSheetProps {
  token: HeatmapToken | null;
  interval: MarketInterval;
  onClose: () => void;
}

/** Boxed value for the sheet's three figure boxes; '—' for unknown. */
export function tokenFigureUsd(value: number | null): string {
  return value === null || !Number.isFinite(value) ? '—' : formatFeedUsd(value, true);
}

const toneColor = (change: number | null): string => {
  const tone = heatmapTone(change);
  return tone === 'up' ? FEED_TOKENS.colors.up : tone === 'down' ? FEED_TOKENS.colors.down : FEED_TOKENS.colors.textDim;
};

/**
 * Token bottom sheet (feed-mock.html #s-tilesheet, DESIGN.md §12): identity
 * with a tone-tinted letter tile, big mono price with change, the volume /
 * mkt cap / liquidity boxes and the trade buttons (Swap primary, Phoenix
 * perps secondary when the token has one). Price and figures are real heatmap
 * values; the "why it moved" card is a sample-gated mock.
 */
export function TokenSheet({ token, interval, onClose }: TokenSheetProps) {
  const router = useRouter();
  const mocks = marketSample();
  const news = token && mocks !== null ? sampleNews(token) : null;
  const routes = token ? tokenTradeRoutes(token) : [];
  const tint = token ? toneColor(token.priceChangePct) : null;
  const letter = token ? token.symbol.charAt(0).toUpperCase() : '';

  return (
    <FeedSheet visible={token !== null} onClose={onClose}>
      {token ? (
        <View>
          <View style={styles.metaRow}>
            <Text accessibilityRole="header" style={styles.meta}>Token · Solana</Text>
            <Text style={styles.metaAge}>{token.name} · {interval}</Text>
          </View>
          <View style={styles.identityRow}>
            <View style={[styles.letterTile, { borderColor: tint ?? FEED_TOKENS.colors.border }]}>
              <Text style={[styles.letter, { color: tint ?? FEED_TOKENS.colors.textDim }]}>{letter}</Text>
            </View>
            <Text accessibilityRole="header" style={styles.name} numberOfLines={2}>
              {token.name} <Text style={styles.symbol}>${token.symbol}</Text>
            </Text>
          </View>
          <View style={styles.priceRow}>
            <Text style={styles.price}>{formatTokenPrice(token.priceUsd)}</Text>
            <Text style={[styles.change, { color: toneColor(token.priceChangePct) }]}>{changeText(token.priceChangePct)}</Text>
          </View>
          <View style={styles.figures}>
            <View style={styles.figureBox}>
              <Text style={styles.figureLabel}>Volume</Text>
              <Text style={styles.figureValue}>{tokenFigureUsd(token.volumeUsd)}</Text>
            </View>
            <View style={styles.figureBox}>
              <Text style={styles.figureLabel}>Mkt cap</Text>
              <Text style={styles.figureValue}>{tokenFigureUsd(token.marketCapUsd)}</Text>
            </View>
            <View style={styles.figureBox}>
              <Text style={styles.figureLabel}>Liquidity</Text>
              <Text style={styles.figureValue}>{tokenFigureUsd(token.liquidityUsd)}</Text>
            </View>
          </View>
          {news ? (
            <View style={styles.sample}>
              <MockOnly>
                <View style={styles.newsCard}>
                  <Text style={styles.newsHeading}>Why it moved</Text>
                  <Text style={styles.newsTitle}>{news.title}</Text>
                  <Text style={styles.newsMeta}>{news.ago} ago</Text>
                </View>
              </MockOnly>
            </View>
          ) : null}
          {routes.map((entry, index) => (
            <Pressable
              key={entry.label}
              accessibilityRole="button"
              accessibilityLabel={`${entry.label} ${token.symbol}`}
              onPress={() => {
                onClose();
                router.push(entry.route);
              }}
              style={index === 0 ? styles.primaryButton : styles.secondaryButton}
            >
              <Text style={index === 0 ? styles.primaryLabel : styles.secondaryLabel}>
                {index === 0 ? `Swap ${token.symbol}` : entry.label}
              </Text>
            </Pressable>
          ))}
          <Pressable
            accessibilityRole="link"
            accessibilityLabel="Open this token on Solscan"
            onPress={() => { void Linking.openURL(`https://solscan.io/token/${token.address}`); }}
            style={styles.sourceLink}
          >
            <Text style={styles.sourceLinkLabel}>View on Solscan ↗</Text>
          </Pressable>
        </View>
      ) : null}
    </FeedSheet>
  );
}

const styles = StyleSheet.create({
  metaRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: FEED_TOKENS.space.sm,
    marginBottom: FEED_TOKENS.space.sm,
  },
  meta: {
    color: FEED_TOKENS.colors.text,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.label,
    letterSpacing: 1,
    textTransform: 'uppercase',
    flexShrink: 1,
  },
  metaAge: {
    color: FEED_TOKENS.colors.textDim,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.label,
    letterSpacing: 1,
  },
  identityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: FEED_TOKENS.space.md,
    marginTop: FEED_TOKENS.space.xs,
  },
  letterTile: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 20,
    borderWidth: 1,
  },
  letter: {
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.body,
    fontWeight: '700',
  },
  name: {
    flex: 1,
    color: FEED_TOKENS.colors.text,
    fontSize: FEED_TOKENS.type.section,
    lineHeight: 25,
    fontWeight: '700',
    letterSpacing: -0.2,
  },
  symbol: {
    color: FEED_TOKENS.colors.textDim,
    fontSize: FEED_TOKENS.type.body,
    fontWeight: '600',
  },
  priceRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: FEED_TOKENS.space.md,
    marginTop: FEED_TOKENS.space.md,
  },
  price: {
    color: FEED_TOKENS.colors.text,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.title,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  change: {
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.body,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  figures: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: FEED_TOKENS.space.sm,
    marginTop: FEED_TOKENS.space.md,
  },
  figureBox: {
    flexBasis: '30%',
    flexGrow: 1,
    borderWidth: 1,
    borderColor: FEED_TOKENS.colors.border,
    borderRadius: FEED_TOKENS.radius.card,
    backgroundColor: FEED_TOKENS.colors.card,
    padding: FEED_TOKENS.space.md,
    gap: FEED_TOKENS.space.xs,
  },
  figureLabel: {
    color: FEED_TOKENS.colors.textFaint,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.label,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  figureValue: {
    color: FEED_TOKENS.colors.text,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.body,
    fontWeight: '700',
  },
  sample: {
    marginTop: FEED_TOKENS.space.md,
    gap: FEED_TOKENS.space.sm,
  },
  newsCard: {
    borderWidth: 1,
    borderColor: FEED_TOKENS.colors.border,
    borderRadius: FEED_TOKENS.radius.card,
    backgroundColor: FEED_TOKENS.colors.card,
    padding: FEED_TOKENS.space.md,
    gap: FEED_TOKENS.space.xs,
  },
  newsHeading: {
    color: FEED_TOKENS.colors.text,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.label,
    fontWeight: '600',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  newsTitle: {
    color: FEED_TOKENS.colors.text,
    fontSize: FEED_TOKENS.type.body,
    fontWeight: '600',
  },
  newsMeta: {
    color: FEED_TOKENS.colors.textDim,
    fontSize: FEED_TOKENS.type.caption,
    lineHeight: 17,
  },
  primaryButton: {
    marginTop: FEED_TOKENS.space.lg,
    minHeight: 48,
    borderWidth: 1,
    borderColor: FEED_TOKENS.colors.accent,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryLabel: {
    color: FEED_TOKENS.colors.accent,
    fontSize: FEED_TOKENS.type.body,
    fontWeight: '600',
  },
  secondaryButton: {
    marginTop: FEED_TOKENS.space.sm,
    minHeight: 48,
    borderWidth: 1,
    borderColor: FEED_TOKENS.colors.border,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryLabel: {
    color: FEED_TOKENS.colors.text,
    fontSize: FEED_TOKENS.type.body,
    fontWeight: '600',
  },
  sourceLink: {
    marginTop: FEED_TOKENS.space.md,
    minHeight: 44,
    alignSelf: 'flex-start',
    justifyContent: 'center',
  },
  sourceLinkLabel: {
    color: FEED_TOKENS.colors.accent,
    fontSize: FEED_TOKENS.type.caption,
    fontWeight: '700',
  },
});