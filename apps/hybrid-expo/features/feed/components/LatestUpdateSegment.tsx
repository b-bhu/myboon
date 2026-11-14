import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { FEED_TOKENS, monoFontFamily } from '../feed-design';
import { sectionFailureTitle } from '../feed-mosaic';
import {
  latestUpdateTime,
  type LatestUpdatesPresentation,
} from '../latest-updates';
import type { LatestUpdate, LatestUpdateSource } from '@myboon/shared/latest-updates';
import { FeedBox } from './ui/FeedBox';
import { SampleDataLabel } from './ui/SampleDataLabel';

const SECTIONS: readonly { key: 'whatHappened' | 'howWeGotHere' | 'whatToWatch'; label: string }[] = [
  { key: 'whatHappened', label: 'What happened' },
  { key: 'howWeGotHere', label: 'How we got here' },
  { key: 'whatToWatch', label: 'What to watch' },
];

/**
 * Latest-update segment. An empty list renders nothing, which is the
 * agreed state while nothing is live. A failed request stays in this
 * block so the rest of the Feed keeps working.
 */
export function LatestUpdateSegment({
  presentation,
  onRetry,
  now = new Date(),
}: {
  presentation: LatestUpdatesPresentation;
  onRetry: () => void;
  now?: Date;
}) {
  if (presentation.status === 'empty') return null;

  return (
    <View style={styles.segment} accessibilityLabel="Latest update">
      <View style={styles.heading}>
        <Text accessibilityRole="header" style={styles.kicker}>Latest update</Text>
        {presentation.sample ? <SampleDataLabel enabled /> : null}
      </View>
      {presentation.status === 'loading' ? <LatestUpdateSkeleton /> : null}
      {presentation.status === 'unavailable' ? (
        <LatestUpdateUnavailable
          title={sectionFailureTitle(presentation.message ?? '', 'Latest updates unavailable')}
          text="Latest updates could not be loaded."
          onRetry={onRetry}
        />
      ) : null}
      {presentation.status === 'ready' ? presentation.updates.map((update) => (
        <LatestUpdateCard key={update.id} update={update} now={now} />
      )) : null}
    </View>
  );
}

function LatestUpdateCard({ update, now }: { update: LatestUpdate; now: Date }) {
  const time = latestUpdateTime(update.publishedAt, now);
  return (
    <FeedBox tone="card" accessibilityLabel={`${update.entityName}. ${update.headline}. ${time}`}>
      <View style={styles.card}>
        <Text style={styles.metaRow}>
          <Text style={styles.entity}>{update.entityName}</Text>
          <Text style={styles.time}> · </Text>
          <Text style={styles.time}>{time}</Text>
        </Text>
        <Text style={styles.headline}>{update.headline}</Text>
        {SECTIONS.map((section) => (
          <View key={section.key} style={styles.section}>
            <Text style={styles.sectionLabel}>{section.label}</Text>
            <Text style={styles.body}>{update[section.key]}</Text>
          </View>
        ))}
        {update.sources.length ? (
          <View style={styles.sources}>
            <Text style={styles.sectionLabel}>Sources</Text>
            {update.sources.map((source) => (
              <SourceLink key={source.itemId} source={source} />
            ))}
          </View>
        ) : null}
      </View>
    </FeedBox>
  );
}

function SourceLink({ source }: { source: LatestUpdateSource }) {
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={source.title}
      onPress={() => { void Linking.openURL(source.link); }}
      style={styles.sourceLink}
    >
      <Text style={styles.sourceTitle}>{source.title}</Text>
    </Pressable>
  );
}

function LatestUpdateSkeleton() {
  return (
    <View style={styles.skeleton} accessibilityLabel="Loading latest updates">
      <View style={[styles.skeletonLine, styles.skeletonKicker]} />
      <View style={[styles.skeletonLine, styles.skeletonHeadline]} />
      <View style={[styles.skeletonLine, styles.skeletonBody]} />
      <View style={[styles.skeletonLine, styles.skeletonBodyShort]} />
    </View>
  );
}

function LatestUpdateUnavailable({ title, text, onRetry }: {
  title: string;
  text: string;
  onRetry: () => void;
}) {
  return (
    <View style={styles.unavailable} accessibilityLiveRegion="polite">
      <Text selectable style={styles.unavailableTitle}>{title}</Text>
      <Text selectable style={styles.unavailableText}>{text}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Retry ${title}`}
        onPress={onRetry}
        style={styles.retry}
      >
        <Text style={styles.retryLabel}>Retry</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  segment: {
    gap: FEED_TOKENS.space.sm,
  },
  card: {
    gap: FEED_TOKENS.space.md,
  },
  metaRow: {
    color: FEED_TOKENS.colors.textDim,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.label,
    letterSpacing: 1,
  },
  heading: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: FEED_TOKENS.space.sm,
  },
  kicker: {
    color: FEED_TOKENS.colors.textDim,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.label,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  entity: {
    color: FEED_TOKENS.colors.textDim,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.label,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  time: {
    color: FEED_TOKENS.colors.textFaint,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.label,
    letterSpacing: 0,
    textTransform: 'none',
  },
  headline: {
    color: FEED_TOKENS.colors.text,
    fontSize: FEED_TOKENS.type.section,
    lineHeight: 26,
    fontWeight: '700',
  },
  section: {
    gap: FEED_TOKENS.space.xs,
  },
  sectionLabel: {
    color: FEED_TOKENS.colors.textFaint,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.label,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  body: {
    color: FEED_TOKENS.colors.text,
    fontSize: FEED_TOKENS.type.body,
    lineHeight: 22,
  },
  sources: {
    gap: FEED_TOKENS.space.xs,
    marginTop: FEED_TOKENS.space.xs,
  },
  sourceLink: {
    minHeight: 44,
    justifyContent: 'center',
  },
  sourceTitle: {
    color: FEED_TOKENS.colors.accent,
    fontSize: FEED_TOKENS.type.caption,
    lineHeight: 16,
  },
  skeleton: {
    borderWidth: 1,
    borderColor: FEED_TOKENS.colors.border,
    borderRadius: FEED_TOKENS.radius.card,
    backgroundColor: FEED_TOKENS.colors.card,
    padding: FEED_TOKENS.space.md,
    gap: FEED_TOKENS.space.md,
  },
  skeletonLine: {
    height: 12,
    borderRadius: FEED_TOKENS.radius.chip,
    backgroundColor: FEED_TOKENS.colors.border,
  },
  skeletonKicker: {
    width: '32%',
    height: 10,
  },
  skeletonHeadline: {
    width: '78%',
    height: 20,
  },
  skeletonBody: {
    width: '92%',
  },
  skeletonBodyShort: {
    width: '64%',
  },
  unavailable: {
    padding: FEED_TOKENS.space.md,
    gap: FEED_TOKENS.space.sm,
    backgroundColor: FEED_TOKENS.colors.card,
    borderWidth: 1,
    borderColor: FEED_TOKENS.colors.border,
    borderRadius: FEED_TOKENS.radius.card,
  },
  unavailableTitle: {
    color: FEED_TOKENS.colors.text,
    fontSize: FEED_TOKENS.type.body,
    fontWeight: '700',
    lineHeight: 21,
  },
  unavailableText: {
    color: FEED_TOKENS.colors.textDim,
    fontSize: FEED_TOKENS.type.secondary,
    lineHeight: 20,
  },
  retry: {
    minHeight: 44,
    alignSelf: 'flex-start',
    justifyContent: 'center',
    paddingHorizontal: FEED_TOKENS.space.sm,
  },
  retryLabel: {
    color: FEED_TOKENS.colors.accent,
    fontSize: FEED_TOKENS.type.secondary,
    fontWeight: '700',
  },
});
