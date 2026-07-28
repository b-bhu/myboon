import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { fetchTrendingMarkets } from '@/features/predict/predict.api';
import type { TrendingMarket } from '@/features/predict/predict.types';
import { semantic, tokens } from '@/theme';

interface EmptyPortfolioProps {
  mode: 'no-account' | 'no-balance' | 'no-picks';
  onPrimaryAction: () => void;
  primaryLabel: string;
}

const EMPTY_COPY: Record<EmptyPortfolioProps['mode'], {
  icon: keyof typeof MaterialIcons.glyphMap;
  title: string;
  description: string;
}> = {
  'no-account': {
    icon: 'check-circle',
    title: 'Set up Polymarket',
    description: 'Set up Polymarket to start making picks. No transaction, no gas, no cost.',
  },
  'no-balance': {
    icon: 'add-card',
    title: 'Deposit USDC to make your first pick',
    description: 'Send USDC on Polygon. Funds show up here when ready.',
  },
  'no-picks': {
    icon: 'touch-app',
    title: 'No picks yet',
    description: 'Your cash is ready. Pick an outcome and it will show up here with its status and next action.',
  },
};

export function EmptyPortfolio({ mode, onPrimaryAction, primaryLabel }: EmptyPortfolioProps) {
  const router = useRouter();
  const [trending, setTrending] = useState<TrendingMarket[]>([]);
  const [loading, setLoading] = useState(true);
  const copy = EMPTY_COPY[mode];
  // Matched on the label because that is the only signal the caller passes.
  // Kept in step with `predict-profile.tsx`, which sends 'Connect wallet' when
  // no wallet is connected and 'Set up Polymarket' once one is — a stale value
  // here silently shows setup copy above a connect button.
  const signedOut = mode === 'no-account' && primaryLabel.toLowerCase() === 'connect wallet';

  useEffect(() => {
    fetchTrendingMarkets(5)
      .then(setTrending)
      .catch(() => setTrending([]))
      .finally(() => setLoading(false));
  }, []);

  if (mode === 'no-account') {
    return (
      <View style={styles.container}>
        <View style={styles.onboardHero}>
          <View style={styles.onboardIcon}>
            <MaterialIcons name={copy.icon} size={24} color={tokens.colors.viridian} />
          </View>
          <Text style={styles.onboardTitle}>
            {signedOut ? 'Connect wallet' : copy.title}
          </Text>
          <Text style={styles.onboardSubtitle}>
            {signedOut
              ? 'Connect a wallet to set up Polymarket, make picks, and collect winnings in one place.'
              : copy.description}
          </Text>
        </View>

        <View style={styles.ctaPad}>
          <Pressable style={styles.ctaBtn} onPress={onPrimaryAction}>
            <Text style={styles.ctaBtnText}>{primaryLabel}</Text>
          </Pressable>
          {!signedOut && (
            <Text style={styles.reassurance}>
              One signature prepares your Polymarket account.{'\n'}No transaction. No gas. No cost.
            </Text>
          )}
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {mode === 'no-balance' ? (
        <View style={styles.depositPrompt}>
          <Text style={styles.eyebrow}>Get started</Text>
          <Text style={styles.promptTitle}>{copy.title}</Text>
          <Text style={styles.promptCopy}>{copy.description}</Text>
          <Pressable style={styles.ctaBtn} onPress={onPrimaryAction}>
            <MaterialIcons name="arrow-downward" size={12} color={tokens.colors.backgroundDark} />
            <Text style={styles.ctaBtnText}>{primaryLabel}</Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.sectionWrap}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Your Picks</Text>
            <Text style={styles.sectionCount}>none yet</Text>
          </View>
          <View style={styles.emptyState}>
            <Text style={styles.emptyStateTitle}>{copy.title}</Text>
            <Text style={styles.emptyStateCopy}>{copy.description}</Text>
            <Pressable style={styles.ctaBtn} onPress={onPrimaryAction}>
              <Text style={styles.ctaBtnText}>{primaryLabel}</Text>
            </Pressable>
          </View>
        </View>
      )}

      {/* Trending markets */}
      <View style={styles.sectionWrap}>
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>{mode === 'no-picks' ? 'Markets to watch' : 'Trending Markets'}</Text>
          <Text style={styles.sectionCount}>{mode === 'no-picks' ? 'popular now' : 'explore'}</Text>
        </View>
        {loading ? (
          <ActivityIndicator size="small" color={semantic.text.faint} style={{ paddingVertical: 20 }} />
        ) : trending.length === 0 ? (
          <Text style={styles.trendingEmpty}>No markets available</Text>
        ) : (
          trending.map((m, i) => {
            const yesPrice = m.yesPrice ?? 0;
            return (
              <Pressable
                key={`${m.slug}-${i}`}
                style={styles.marketRow}
                onPress={() => router.push(`/markets/polymarket/market/${encodeURIComponent(m.slug)}`)}
                accessibilityLabel={`View market: ${m.question}`}
              >
                <View style={styles.marketInfo}>
                  <Text style={styles.marketQuestion} numberOfLines={2}>
                    {m.question}
                  </Text>
                  <View style={styles.oddsBar}>
                    <View style={[styles.oddsSegment, styles.yesSegment, { flex: Math.max(yesPrice, 0.01) }]}>
                      <Text style={styles.oddsText}>Yes {Math.round(yesPrice * 100)}%</Text>
                    </View>
                    <View style={[styles.oddsSegment, styles.noSegment, { flex: Math.max(1 - yesPrice, 0.01) }]}>
                      <Text style={styles.oddsText}>No {Math.round((1 - yesPrice) * 100)}%</Text>
                    </View>
                  </View>
                  {m.volume24h != null && m.volume24h > 0 && (
                    <Text style={styles.marketVol}>
                      ${m.volume24h >= 1000 ? `${(m.volume24h / 1000).toFixed(0)}K` : m.volume24h.toFixed(0)} vol
                    </Text>
                  )}
                </View>
              </Pressable>
            );
          })
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 16,
  },

  onboardHero: {
    paddingTop: 24,
    paddingHorizontal: 20,
    paddingBottom: 12,
    alignItems: 'center',
    gap: 8,
  },
  onboardIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: 'rgba(74,140,111,0.22)',
    backgroundColor: 'rgba(74,140,111,0.10)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  onboardTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: semantic.text.primary,
    textAlign: 'center',
    lineHeight: 24,
  },
  onboardSubtitle: {
    fontFamily: 'monospace',
    fontSize: 9,
    color: semantic.text.dim,
    textAlign: 'center',
    lineHeight: 15,
    maxWidth: 280,
  },
  ctaPad: {
    paddingHorizontal: 20,
    alignItems: 'center',
    gap: 6,
  },
  reassurance: {
    fontFamily: 'monospace',
    fontSize: 7.5,
    color: semantic.text.faint,
    textAlign: 'center',
    lineHeight: 12,
  },
  depositPrompt: {
    paddingVertical: 24,
    paddingHorizontal: 20,
    alignItems: 'center',
    gap: 8,
  },
  eyebrow: {
    fontFamily: 'monospace',
    fontSize: 7.5,
    letterSpacing: 2,
    textTransform: 'uppercase',
    color: semantic.text.dim,
  },
  promptTitle: {
    fontSize: 12,
    color: semantic.text.primary,
    lineHeight: 18,
    textAlign: 'center',
  },
  promptCopy: {
    fontFamily: 'monospace',
    fontSize: 8,
    color: semantic.text.faint,
    textAlign: 'center',
    lineHeight: 13,
    marginBottom: 6,
  },
  ctaBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: tokens.colors.viridian,
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 6,
    marginTop: 4,
    minHeight: 36,
  },
  ctaBtnText: {
    fontFamily: 'monospace',
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    color: tokens.colors.backgroundDark,
  },

  sectionWrap: {
    gap: 8,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sectionTitle: {
    fontFamily: 'monospace',
    fontSize: 8,
    letterSpacing: 2,
    textTransform: 'uppercase',
    color: semantic.text.primary,
    fontWeight: '700',
  },
  sectionCount: {
    fontFamily: 'monospace',
    fontSize: 7.5,
    color: semantic.text.faint,
  },
  emptyState: {
    backgroundColor: semantic.background.surface,
    borderWidth: 1,
    borderColor: semantic.border.muted,
    borderRadius: 8,
    padding: 18,
    alignItems: 'center',
    gap: 8,
  },
  emptyStateTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: semantic.text.primary,
  },
  emptyStateCopy: {
    fontFamily: 'monospace',
    fontSize: 8,
    color: semantic.text.faint,
    textAlign: 'center',
    lineHeight: 13,
  },
  trendingEmpty: {
    fontFamily: 'monospace',
    fontSize: 9,
    color: semantic.text.faint,
    textAlign: 'center',
    paddingVertical: 16,
  },
  marketRow: {
    backgroundColor: semantic.background.surface,
    borderWidth: 1,
    borderColor: semantic.border.muted,
    borderRadius: 8,
    padding: 12,
    minHeight: 72,
    gap: 8,
  },
  marketInfo: {
    gap: 7,
  },
  marketQuestion: {
    fontSize: 10,
    color: semantic.text.primary,
    lineHeight: 14,
  },
  marketVol: {
    fontFamily: 'monospace',
    fontSize: 7.5,
    color: semantic.text.faint,
  },
  oddsBar: {
    flexDirection: 'row',
    minHeight: 24,
    borderRadius: 6,
    overflow: 'hidden',
    gap: 2,
  },
  oddsSegment: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  yesSegment: {
    backgroundColor: 'rgba(74,140,111,0.22)',
  },
  noSegment: {
    backgroundColor: 'rgba(244,88,78,0.16)',
  },
  oddsText: {
    fontFamily: 'monospace',
    fontSize: 8,
    fontWeight: '700',
    color: semantic.text.primary,
  },
});
