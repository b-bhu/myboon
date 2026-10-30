import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { FeedBox } from '@/features/feed/components/ui/FeedBox';
import { FeedSheet } from '@/features/feed/components/ui/FeedSheet';
import { SectionHeader } from '@/features/feed/components/ui/SectionHeader';
import { SegmentedTabs } from '@/features/feed/components/ui/SegmentedTabs';
import { MockOnly } from '@/features/feed/components/ui/SampleDataLabel';
import { FEED_TOKENS, monoFontFamily } from '@/features/feed/feed-design';
import type { FeedBoxTone } from '@/features/feed/feed-design';
import { FEED_FIXTURES } from '@/features/feed/feed-fixtures';
import { FEED_MOCKS } from '@/features/feed/feed-mocks';

function PreviewCard({ tone, title, body, meta }: {
  tone: FeedBoxTone;
  title: string;
  body: string;
  meta: string;
}) {
  return (
    <FeedBox style={styles.card} tone={tone}>
      <Text style={styles.cardTitle}>{title}</Text>
      <Text style={styles.cardBody}>{body}</Text>
      <Text style={styles.cardMeta}>{meta}</Text>
    </FeedBox>
  );
}

export default function DevFeedPrimitivesRoute() {
  const params = useLocalSearchParams<{ sheet?: string }>();
  const sheetParam = Array.isArray(params.sheet) ? params.sheet[0] : params.sheet;
  const [segment, setSegment] = useState('active');
  const [sheetOpen, setSheetOpen] = useState(sheetParam === '1');

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <SectionHeader title="Today" linkLabel="All updates →" onLinkPress={() => {}} />

        <FeedBox style={styles.card} tone="ground" accessibilityLabel="Glance preview">
          <Text style={styles.cardTitle}>Bitcoin ETFs return to net inflows</Text>
          <Text style={styles.cardBody}>
            Third straight session of positive flows as desks re-open risk.
          </Text>
          <Text style={styles.cardMeta}>2M · ETF DESK</Text>
        </FeedBox>
        <PreviewCard
          tone="card"
          title="Solana DEX volume cools"
          body="Weekly turnover slipped to a one-month low across majors."
          meta="18M · MARKETS"
        />
        <PreviewCard
          tone="lift"
          title="Meteora opens LST vaults"
          body="Two new vaults list with double-digit APRs at launch."
          meta="42M · PROTOCOL"
        />

        <SegmentedTabs
          options={[
            { key: 'active', label: 'Active' },
            { key: 'past', label: 'Past' },
          ]}
          value={segment}
          onChange={setSegment}
        />

        <MockOnly enabled={FEED_MOCKS}>
          <FeedBox style={styles.card} tone="card">
            <Text style={styles.cardTitle}>Key numbers</Text>
            <View style={styles.mockRows}>
              {FEED_FIXTURES.storyKeyNumbers.map((row) => (
                <View key={row.label} style={styles.mockRow}>
                  <Text style={styles.cardMeta}>{row.label}</Text>
                  <Text style={styles.mockValue}>{String(row.value)}</Text>
                </View>
              ))}
            </View>
          </FeedBox>
        </MockOnly>

        <Pressable
          accessibilityRole="button"
          onPress={() => setSheetOpen(true)}
          style={styles.button}
        >
          <Text style={styles.buttonText}>Open sheet</Text>
        </Pressable>
      </ScrollView>

      <FeedSheet visible={sheetOpen} onClose={() => setSheetOpen(false)}>
        <Text style={styles.sheetTitle}>Catch-up</Text>
        <Text style={styles.sheetMeta}>UPDATED · 09:42 IST · MYBOON DESK</Text>
        {FEED_FIXTURES.storyCatchUp.map((point) => (
          <Text key={point} style={styles.sheetBody}>
            {point}
          </Text>
        ))}
      </FeedSheet>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: FEED_TOKENS.colors.screen,
  },
  content: {
    padding: FEED_TOKENS.space.lg,
    gap: FEED_TOKENS.space.md,
  },
  card: {
    marginBottom: FEED_TOKENS.space.md,
  },
  cardTitle: {
    color: FEED_TOKENS.colors.text,
    fontSize: FEED_TOKENS.type.cardTitle,
    fontWeight: '700',
  },
  cardBody: {
    color: FEED_TOKENS.colors.textDim,
    fontSize: FEED_TOKENS.type.body,
  },
  cardMeta: {
    color: FEED_TOKENS.colors.textFaint,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.label,
    letterSpacing: 1,
  },
  mockRows: {
    gap: FEED_TOKENS.space.xs,
  },
  mockRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: FEED_TOKENS.space.sm,
  },
  mockValue: {
    color: FEED_TOKENS.colors.text,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.secondary,
  },
  button: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
    borderWidth: 1,
    borderColor: FEED_TOKENS.colors.accent,
    borderRadius: FEED_TOKENS.radius.button,
    marginBottom: FEED_TOKENS.space.md,
  },
  buttonText: {
    color: FEED_TOKENS.colors.accent,
    fontSize: FEED_TOKENS.type.body,
    fontWeight: '600',
  },
  sheetTitle: {
    color: FEED_TOKENS.colors.text,
    fontSize: FEED_TOKENS.type.cardTitle,
    fontWeight: '700',
  },
  sheetMeta: {
    color: FEED_TOKENS.colors.textFaint,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.label,
    letterSpacing: 1,
    marginVertical: FEED_TOKENS.space.xs,
  },
  sheetBody: {
    color: FEED_TOKENS.colors.textDim,
    fontSize: FEED_TOKENS.type.body,
    marginBottom: FEED_TOKENS.space.sm,
  },
});