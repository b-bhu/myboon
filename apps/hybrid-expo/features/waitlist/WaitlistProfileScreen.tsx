import { useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppTopBar, AppTopBarIconButton, AppTopBarTitle } from '@/components/AppTopBar';
import { WaitlistSheet } from '@/features/waitlist/WaitlistSheet';
import {
  PRIVACY_URL,
  TERMS_URL,
  WAITLIST_CTA,
  WAITLIST_PITCH,
} from '@/features/waitlist/waitlist.mode';
import { useOddsFormat, type OddsFormat } from '@/hooks/useOddsFormat';
import { semantic, tokens } from '@/theme';

const ODDS: { id: OddsFormat; label: string }[] = [
  { id: 'probability', label: 'Probability' },
  { id: 'decimal', label: 'Decimal' },
  { id: 'points', label: 'Points' },
];

/** Profile body without wallet parts: waitlist card, settings, legal links. */
export function WaitlistProfileContent({ bottomPadding = 24 }: { bottomPadding?: number }) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const { format, setFormat } = useOddsFormat();
  return (
    <ScrollView contentContainerStyle={[styles.content, { paddingBottom: bottomPadding }]}>
      <View style={styles.card}>
        <MaterialIcons name="lock-clock" size={28} color={tokens.colors.accent} />
        <Text style={styles.cardText}>{WAITLIST_PITCH}</Text>
        <Pressable accessibilityRole="button" onPress={() => setSheetOpen(true)} style={styles.cta}>
          <Text style={styles.ctaText}>{WAITLIST_CTA}</Text>
        </Pressable>
      </View>

      <Text style={styles.section}>SETTINGS</Text>
      <View style={styles.group}>
        <Text style={styles.rowLabel}>Odds format</Text>
        <View style={styles.segment}>
          {ODDS.map(({ id, label }) => (
            <Pressable
              key={id}
              accessibilityRole="button"
              accessibilityState={{ selected: format === id }}
              onPress={() => setFormat(id)}
              style={[styles.segmentItem, format === id && styles.segmentSelected]}
            >
              <Text style={[styles.segmentText, format === id && styles.segmentTextSelected]}>{label}</Text>
            </Pressable>
          ))}
        </View>
      </View>

      <Text style={styles.section}>ABOUT</Text>
      <View style={styles.group}>
        <LinkRow label="Privacy policy" url={PRIVACY_URL} />
        <View style={styles.divider} />
        <LinkRow label="Terms of service" url={TERMS_URL} />
      </View>
      <WaitlistSheet visible={sheetOpen} onClose={() => setSheetOpen(false)} />
    </ScrollView>
  );
}

function LinkRow({ label, url }: { label: string; url: string }) {
  return (
    <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(url)} style={styles.linkRow}>
      <Text style={styles.rowLabel}>{label}</Text>
      <MaterialIcons name="open-in-new" size={16} color={semantic.text.faint} />
    </Pressable>
  );
}

/** Stands in for every app's profile route in waitlist mode. */
export function WaitlistProfileScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <AppTopBar
        left={<AppTopBarIconButton icon="arrow-back" onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))} accessibilityLabel="Back" />}
        center={<AppTopBarTitle>Profile</AppTopBarTitle>}
      />
      <WaitlistProfileContent bottomPadding={insets.bottom + 24} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: semantic.background.screen },
  content: { padding: 16, gap: 8 },
  card: {
    alignItems: 'center',
    gap: 10,
    padding: 20,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: semantic.border.muted,
    backgroundColor: semantic.background.surface,
  },
  cardText: { color: semantic.text.primary, fontSize: 15, lineHeight: 21, textAlign: 'center' },
  cta: {
    alignSelf: 'stretch',
    minHeight: 48,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: tokens.colors.accent,
    marginTop: 4,
  },
  ctaText: { color: tokens.colors.backgroundDark, fontSize: 15, fontWeight: '800' },
  section: { color: semantic.text.faint, fontSize: 11, fontWeight: '800', letterSpacing: 1, marginTop: 16 },
  group: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: semantic.border.muted,
    backgroundColor: semantic.background.surface,
    padding: 14,
    gap: 10,
  },
  rowLabel: { color: semantic.text.primary, fontSize: 14, fontWeight: '600' },
  segment: { flexDirection: 'row', gap: 6 },
  segmentItem: {
    flex: 1,
    minHeight: 36,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: semantic.border.muted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segmentSelected: { borderColor: tokens.colors.accent, backgroundColor: 'rgba(255, 209, 102, 0.12)' },
  segmentText: { color: semantic.text.dim, fontSize: 12, fontWeight: '700' },
  segmentTextSelected: { color: tokens.colors.accent },
  linkRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 32 },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: semantic.border.muted },
});
