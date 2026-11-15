/**
 * Shared detail-frame sections for the one MarketScreen (#651).
 *
 * Presentational only: venue logic builds a MarketDetailViewModel and this
 * file renders it. Only the chart body is venue-swapped; everything below is
 * identical across Phoenix, Pacifica, Polymarket and Meteora.
 */

import { Image } from 'expo-image';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { semantic, tokens } from '@/theme';
import type {
  MarketDetailActionBarVM,
  MarketDetailPriceRowVM,
  MarketDetailRangeVM,
  MarketDetailTopBarVM,
  NewsStoryCard,
  PositionRowVM,
  ValueTone,
} from '@/features/markets/detail-view-model';

const mono = { fontFamily: 'monospace' } as const;

function toneStyle(tone: ValueTone) {
  if (tone === 'up') return styles.toneUp;
  if (tone === 'down') return styles.toneDown;
  return styles.toneFlat;
}

export function TopBarSection({ vm }: { vm: MarketDetailTopBarVM }) {
  return (
    <View style={styles.topBar}>
      <Pressable hitSlop={12} onPress={vm.onBack} style={styles.backButton}>
        <Text style={styles.backGlyph}>&#8249;</Text>
      </Pressable>
      <Text style={styles.marketName} numberOfLines={1}>
        {vm.marketName}
      </Text>
      <View style={styles.badgeRowWrap}>
        <View style={styles.venueBadge}>
          <Text style={styles.venueBadgeText}>{vm.venueBadge}</Text>
        </View>
        {vm.onInfoPress ? (
          <Pressable hitSlop={12} onPress={vm.onInfoPress} style={styles.infoButton}>
            <Text style={styles.infoGlyph}>i</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

export function PriceRowSection({ vm }: { vm: MarketDetailPriceRowVM }) {
  return (
    <View style={styles.priceRow}>
      <Text style={styles.priceBig}>{vm.price}</Text>
      {vm.change ? <Text style={[styles.changeText, toneStyle(vm.change.tone)]}>{vm.change.text}</Text> : null}
      {vm.live ? <View style={styles.liveDotRow} /> : null}
      {vm.secondaryStat ? (
        <View style={styles.secondaryStat}>
          <Text style={styles.secondaryStatLabel}>{vm.secondaryStat.label}</Text>
          <Text style={styles.secondaryStatValue}>{vm.secondaryStat.value}</Text>
        </View>
      ) : null}
    </View>
  );
}

export function RangeNewsStrip({ vm }: { vm: MarketDetailRangeVM }) {
  if (vm.ranges.length === 0 && !vm.onToggleNews) return null;
  return (
    <View style={styles.rangeStrip}>
      <View style={styles.rangePills}>
        {vm.ranges.map((range) => {
          const active = range === vm.activeRange;
          return (
            <Pressable key={range} onPress={() => vm.onSelectRange(range)} style={[styles.rangePill, active && styles.rangePillActive]}>
              <Text style={[styles.rangePillText, active && styles.rangePillTextActive]}>{range}</Text>
            </Pressable>
          );
        })}
      </View>
      {vm.onToggleNews ? (
        <Pressable hitSlop={8} onPress={vm.onToggleNews} style={[styles.newsToggle, !vm.newsVisible && styles.newsToggleOff]}>
          <Text style={[styles.newsToggleText, !vm.newsVisible && styles.newsToggleTextOff]}>News</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function RsiSlot() {
  return <View style={styles.rsiSlot} />;
}

export function NewsRailSection({ stories }: { stories: readonly NewsStoryCard[] }) {
  if (stories.length === 0) return null;
  return (
    <View style={styles.newsRail}>
      {stories.map((story) => {
        const body = (
          <View style={styles.newsCard}>
            {story.imageUrl ? (
              <Image source={story.imageUrl} style={styles.newsThumbWrap} contentFit="cover" />
            ) : (
              <View style={styles.newsThumbWrap}>
                <Text style={styles.newsFallback}>{story.fallbackText ?? '&#10022;'}</Text>
              </View>
            )}
            <View style={styles.newsBody}>
              <Text style={styles.newsLabel} numberOfLines={1}>
                {story.label}
              </Text>
              <Text style={styles.newsTime}>{story.timeLabel}</Text>
            </View>
          </View>
        );
        if (story.onOpen) {
          return (
            <Pressable key={story.id} onPress={story.onOpen}>
              {body}
            </Pressable>
          );
        }
        return <View key={story.id}>{body}</View>;
      })}
    </View>
  );
}

export function PositionRowsSection({
  title,
  rows,
  footer,
}: {
  title: string;
  rows: readonly PositionRowVM[];
  footer?: string;
}) {
  if (rows.length === 0 && !footer) return null;
  return (
    <View style={styles.positionsSection}>
      <Text style={styles.positionsTitle}>{title}</Text>
      {rows.map((row) => {
        const body = (
          <View style={styles.positionRow}>
            <View style={styles.positionLeft}>
              <Text style={styles.positionTitle} numberOfLines={1}>
                {row.title}
              </Text>
              <Text style={styles.positionDetail} numberOfLines={1}>
                {row.detail}
              </Text>
            </View>
            <View style={styles.positionRight}>
              <Text style={[styles.positionValue, mono, toneStyle(row.tone)]}>{row.value}</Text>
              {row.actions?.length ? (
                <View style={styles.positionActions}>
                  {row.actions.map((action) => (
                    <Pressable key={action.label} hitSlop={8} onPress={action.onPress} style={styles.positionAction}>
                      <Text style={styles.positionActionText}>{action.label}</Text>
                    </Pressable>
                  ))}
                </View>
              ) : null}
            </View>
          </View>
        );
        if (row.onRowPress) {
          return (
            <Pressable key={row.id} onPress={row.onRowPress}>
              {body}
            </Pressable>
          );
        }
        return <View key={row.id}>{body}</View>;
      })}
      {footer ? <Text style={styles.positionsFooter}>{footer}</Text> : null}
    </View>
  );
}

export function PinnedActionBarSection({ vm }: { vm: MarketDetailActionBarVM }) {
  if (!vm.connected) {
    return (
      <View style={styles.actionBar}>
        <Pressable onPress={vm.onConnect} style={styles.connectButton}>
          <Text style={styles.connectButtonText}>{vm.connectLabel ?? vm.connectReason ?? 'Connect wallet to trade'}</Text>
        </Pressable>
      </View>
    );
  }
  return (
    <View style={styles.actionBar}>
      {vm.buttons.map((button) => (
        <Pressable
          key={button.label}
          onPress={button.onPress}
          disabled={button.disabled}
          style={[
            styles.actionBarButton,
            button.variant === 'primary' ? styles.actionBarPrimary : styles.actionBarSecondary,
            button.disabled && styles.actionBarBarButtonDisabled,
          ]}
        >
          {button.busy ? (
            <ActivityIndicator size="small" color={button.variant === 'primary' ? styles.actionBarPrimaryText.color : semantic.text.accent} />
          ) : (
            <Text style={button.variant === 'primary' ? styles.actionBarPrimaryText : styles.actionBarSecondaryText}>{button.label}</Text>
          )}
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: tokens.spacing.sm,
    gap: tokens.spacing.sm,
  },
  backButton: {
    width: 28,
    height: 28,
    borderRadius: tokens.radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: semantic.background.lift,
  },
  backGlyph: {
    color: semantic.text.primary,
    fontSize: tokens.fontSize.lg,
    marginTop: -2,
  },
  marketName: {
    flex: 1,
    color: semantic.text.primary,
    fontSize: tokens.fontSize.lg,
    fontWeight: '700',
  },
  badgeRowWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: tokens.spacing.xs,
  },
  venueBadge: {
    paddingHorizontal: tokens.spacing.sm,
    paddingVertical: 2,
    borderRadius: tokens.radius.full,
    backgroundColor: semantic.background.topCardOverlay,
    overflow: 'hidden',
  },
  venueBadgeText: {
    color: semantic.text.accentDim,
    fontSize: tokens.fontSize.xs,
    fontWeight: '700',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  infoButton: {
    width: 24,
    height: 24,
    borderRadius: tokens.radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: semantic.border.muted,
  },
  infoGlyph: {
    color: semantic.text.dim,
    fontSize: tokens.fontSize.sm,
    fontWeight: '700',
  },
  priceRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    paddingHorizontal: tokens.spacing.md,
    paddingBottom: tokens.spacing.xs,
    gap: tokens.spacing.sm,
  },
  priceBig: {
    color: semantic.text.primary,
    fontSize: tokens.fontSize.xl,
    fontWeight: '700',
  },
  changeText: {
    fontSize: tokens.fontSize.md,
    fontWeight: '600',
  },
  liveDotRow: {
    width: 6,
    height: 6,
    borderRadius: tokens.radius.full,
    backgroundColor: tokens.colors.live,
    alignSelf: 'center',
  },
  secondaryStat: {
    marginLeft: 'auto',
    alignItems: 'flex-end',
  },
  secondaryStatLabel: {
    color: semantic.text.faint,
    fontSize: tokens.fontSize.xs,
    textTransform: 'uppercase',
  },
  secondaryStatValue: {
    color: semantic.text.dim,
    fontSize: tokens.fontSize.sm,
    fontWeight: '600',
  },
  rangeStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: tokens.spacing.xs,
    gap: tokens.spacing.sm,
  },
  rangePills: {
    flexDirection: 'row',
    gap: tokens.spacing.xs,
  },
  rangePill: {
    paddingHorizontal: tokens.spacing.sm,
    paddingVertical: 3,
    borderRadius: tokens.radius.sm,
    backgroundColor: semantic.background.lift,
  },
  rangePillActive: {
    backgroundColor: semantic.text.accent,
  },
  rangePillText: {
    color: semantic.text.dim,
    fontSize: tokens.fontSize.xs,
    fontWeight: '700',
  },
  rangePillTextActive: {
    color: semantic.text.primary,
  },
  newsToggle: {
    marginLeft: 'auto',
    paddingHorizontal: tokens.spacing.sm,
    paddingVertical: 3,
    borderRadius: tokens.radius.sm,
    backgroundColor: semantic.background.lift,
  },
  newsToggleOff: {
    opacity: 0.45,
  },
  newsToggleText: {
    color: semantic.text.dim,
    fontSize: tokens.fontSize.xs,
    fontWeight: '700',
  },
  newsToggleTextOff: {
    color: semantic.text.faint,
  },
  rsiSlot: {
    // Reserved vertical room for the RSI pane (#656) — nothing renders here yet.
    height: 112,
  },
  newsRail: {
    paddingHorizontal: tokens.spacing.md,
    paddingBottom: tokens.spacing.sm,
    gap: tokens.spacing.xs,
  },
  newsCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: semantic.background.surfaceRaised,
    borderRadius: tokens.radius.md,
    borderWidth: 1,
    borderColor: semantic.border.muted,
    padding: tokens.spacing.sm,
    gap: tokens.spacing.sm,
  },
  newsThumbWrap: {
    width: 34,
    height: 34,
    borderRadius: tokens.radius.sm,
    backgroundColor: semantic.background.lift,
    alignItems: 'center',
    justifyContent: 'center',
  },
  newsFallback: {
    color: semantic.text.accentDim,
    fontSize: tokens.fontSize.md,
  },
  newsBody: {
    flex: 1,
    gap: 2,
  },
  newsLabel: {
    color: semantic.text.primary,
    fontSize: tokens.fontSize.md,
    fontWeight: '600',
  },
  newsTime: {
    color: semantic.text.faint,
    fontSize: tokens.fontSize.xs,
  },
  positionsSection: {
    paddingHorizontal: tokens.spacing.md,
    paddingBottom: tokens.spacing.md,
    gap: tokens.spacing.xs,
  },
  positionsTitle: {
    color: semantic.text.dim,
    fontSize: tokens.fontSize.sm,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  actionBarBarButtonDisabled: {
    opacity: 0.45,
  },
  positionsFooter: {
    color: semantic.text.faint,
    fontSize: tokens.fontSize.xs,
  },
  positionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: semantic.background.surfaceRaised,
    borderRadius: tokens.radius.md,
    borderWidth: 1,
    borderColor: semantic.border.muted,
    paddingVertical: tokens.spacing.sm,
    paddingHorizontal: tokens.spacing.md,
  },
  positionLeft: {
    flex: 1,
    gap: 2,
    paddingRight: tokens.spacing.sm,
  },
  positionTitle: {
    color: semantic.text.primary,
    fontSize: tokens.fontSize.md,
    fontWeight: '700',
  },
  positionDetail: {
    color: semantic.text.faint,
    fontSize: tokens.fontSize.xs,
  },
  positionRight: {
    alignItems: 'flex-end',
    gap: 4,
  },
  positionValue: {
    fontSize: tokens.fontSize.md,
    fontWeight: '700',
  },
  positionActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    gap: tokens.spacing.xs,
  },
  positionAction: {
    paddingHorizontal: tokens.spacing.sm,
    paddingVertical: 3,
    borderRadius: tokens.radius.sm,
    backgroundColor: semantic.background.lift,
  },
  positionActionText: {
    color: semantic.text.dim,
    fontSize: tokens.fontSize.xs,
    fontWeight: '700',
  },
  actionBar: {
    flexDirection: 'row',
    gap: tokens.spacing.sm,
    paddingHorizontal: tokens.spacing.md,
    paddingTop: tokens.spacing.sm,
    paddingBottom: tokens.spacing.lg,
    backgroundColor: semantic.background.nav,
    borderTopWidth: 1,
    borderTopColor: semantic.border.nav,
  },
  actionBarButton: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: tokens.spacing.md,
    borderRadius: tokens.radius.md,
  },
  actionBarPrimary: {
    backgroundColor: semantic.text.accent,
  },
  actionBarSecondary: {
    backgroundColor: semantic.background.lift,
    borderWidth: 1,
    borderColor: semantic.border.muted,
  },
  actionBarPrimaryText: {
    color: semantic.background.screen,
    fontSize: tokens.fontSize.md,
    fontWeight: '800',
  },
  actionBarSecondaryText: {
    color: semantic.text.primary,
    fontSize: tokens.fontSize.md,
    fontWeight: '800',
  },
  connectButton: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: tokens.spacing.md,
    borderRadius: tokens.radius.md,
    backgroundColor: semantic.background.lift,
    borderWidth: 1,
    borderColor: semantic.border.nav,
  },
  connectButtonText: {
    color: semantic.text.accentDim,
    fontSize: tokens.fontSize.md,
    fontWeight: '700',
  },
  toneUp: {
    color: semantic.sentiment.positive,
  },
  toneDown: {
    color: semantic.sentiment.negative,
  },
  toneFlat: {
    color: semantic.text.dim,
  },
});
