import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { semantic, tokens } from '@/theme';

/**
 * Featured discovery surfaces for Predict: the one-tap featured carousel and
 * the league browse rail.
 *
 * Honesty rules: these components render exactly what props carry — no
 * invented counts, volumes, or closing times. League identity is wordmark
 * initials only (v1 decision): no emoji flags, no crest images, because the
 * crest pipeline doesn't exist yet.
 */

const CARD_WIDTH = 300;
const CARD_GAP = 12;
/** Snap interval must equal card width + gap so pages land cleanly. */
const SNAP_INTERVAL = CARD_WIDTH + CARD_GAP;

export interface FeaturedCarouselItem {
  slug: string;
  eyebrow: string;
  title: string;
  metaLine: string | null;
}

export function FeaturedCarousel({
  items,
  onPressItem,
}: {
  items: FeaturedCarouselItem[];
  onPressItem: (slug: string) => void;
}) {
  if (items.length === 0) {
    return null;
  }

  return (
    <ScrollView
      horizontal
      pagingEnabled
      showsHorizontalScrollIndicator={false}
      snapToInterval={SNAP_INTERVAL}
      decelerationRate="fast"
      contentContainerStyle={styles.carouselContent}
    >
      {items.map((item) => (
        <Pressable
          key={item.slug}
          accessibilityRole="button"
          accessibilityLabel={item.title}
          onPress={() => onPressItem(item.slug)}
          style={[styles.card, { width: CARD_WIDTH }]}
        >
          <View style={styles.cardBody}>
            <Text style={styles.eyebrow}>{item.eyebrow}</Text>
            <Text style={styles.title} numberOfLines={3}>
              {item.title}
            </Text>
            {item.metaLine !== null && item.metaLine !== '' ? (
              <Text style={styles.metaLine}>{item.metaLine}</Text>
            ) : null}
          </View>
          <MaterialIcons name="chevron-right" size={16} color={semantic.text.faint} />
        </Pressable>
      ))}
    </ScrollView>
  );
}

export interface LeagueRailLeague {
  key: string;
  label: string;
}

/** Wordmark initials: first letter of each word ("Premier League" -> "PL"). */
function leagueInitials(label: string): string {
  return label
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0))
    .join('')
    .toUpperCase();
}

export function LeagueRail({
  leagues,
  onPressLeague,
}: {
  leagues: LeagueRailLeague[];
  onPressLeague: (key: string) => void;
}) {
  if (leagues.length === 0) {
    return null;
  }

  return (
    <View>
      <Text style={styles.railSectionTitle}>Browse by league</Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.railContent}
      >
        {leagues.map((league) => (
          <Pressable
            key={league.key}
            accessibilityRole="button"
            accessibilityLabel={league.label}
            onPress={() => onPressLeague(league.key)}
            style={styles.chip}
          >
            <Text style={styles.chipInitials}>{leagueInitials(league.label)}</Text>
            <Text style={styles.chipLabel}>{league.label}</Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  carouselContent: {
    gap: CARD_GAP,
  },
  card: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 18,
    backgroundColor: tokens.colors.surface,
    borderWidth: 1,
    borderColor: semantic.border.muted,
    padding: 16,
  },
  cardBody: {
    flex: 1,
    marginRight: 8,
  },
  eyebrow: {
    fontFamily: 'monospace',
    fontSize: 9,
    fontWeight: '600',
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    color: semantic.text.faint,
    marginBottom: 6,
  },
  title: {
    fontSize: 15,
    fontWeight: '700',
    color: semantic.text.primary,
    lineHeight: 20,
  },
  metaLine: {
    fontFamily: 'monospace',
    fontSize: 11,
    color: semantic.text.dim,
    marginTop: 6,
  },
  railSectionTitle: {
    fontFamily: 'monospace',
    fontSize: 9,
    fontWeight: '600',
    letterSpacing: 2,
    textTransform: 'uppercase',
    color: semantic.text.faint,
    marginBottom: 10,
  },
  railContent: {
    gap: 8,
    paddingHorizontal: 20,
  },
  chip: {
    height: 44,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 12,
    backgroundColor: tokens.colors.lift,
    borderWidth: 1,
    borderColor: semantic.border.muted,
    paddingHorizontal: 16,
  },
  chipInitials: {
    fontFamily: 'monospace',
    fontSize: 12,
    fontWeight: '700',
    color: semantic.text.primary,
    marginRight: 8,
  },
  chipLabel: {
    fontSize: 13,
    color: semantic.text.dim,
  },
});
