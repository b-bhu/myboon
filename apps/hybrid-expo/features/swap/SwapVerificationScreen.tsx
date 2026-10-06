import { useMemo, useState, useSyncExternalStore } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { WalletActionPanelView } from '@/features/wallet/WalletActionPanel';
import { swapTheme as color } from '@/features/swap/swap.theme';
import { useSwapController } from '@/features/swap/useSwapController';
import {
  createNativeSwapFixture,
  SWAP_NATIVE_FIXTURE_CASES,
  type SwapNativeFixtureCase,
} from '@/features/swap/swap.native-fixture';

const __DEV__ONLY = typeof __DEV__ !== 'undefined' && __DEV__;

export function isSwapNativeFixtureCase(value: string | undefined): value is SwapNativeFixtureCase {
  return SWAP_NATIVE_FIXTURE_CASES.some((item) => item.id === value);
}

function DisabledVerification() {
  return (
    <View style={styles.disabled}>
      <Text style={styles.disabledTitle}>Swap verification is disabled.</Text>
    </View>
  );
}

/** Dev-only surface whose swap controller I/O uses disposable fixture dependencies. */
export function SwapVerificationScreen({ initialCase = 'solana' }: { initialCase?: string }) {
  if (!__DEV__ONLY) return <DisabledVerification />;
  return (
    <SwapVerificationContent
      initialCase={isSwapNativeFixtureCase(initialCase) ? initialCase : 'solana'}
    />
  );
}

function SwapVerificationContent({ initialCase }: { initialCase: SwapNativeFixtureCase }) {
  const [fixtureCase, setFixtureCase] = useState<SwapNativeFixtureCase>(initialCase);
  return (
    <SwapVerificationCase
      key={fixtureCase}
      fixtureCase={fixtureCase}
      onCase={setFixtureCase}
    />
  );
}

function SwapVerificationCase({
  fixtureCase,
  onCase,
}: {
  fixtureCase: SwapNativeFixtureCase;
  onCase: (value: SwapNativeFixtureCase) => void;
}) {
  const [active, setActive] = useState(true);
  const [busy, setBusy] = useState(false);
  const fixture = useMemo(() => createNativeSwapFixture(fixtureCase), [fixtureCase]);
  const counts = JSON.parse(
    useSyncExternalStore(
      fixture.subscribe,
      fixture.getCallCountsSnapshot,
      fixture.getCallCountsSnapshot,
    ),
  ) as ReturnType<typeof fixture.getCallCounts>;
  const controller = useSwapController({
    mode: 'swap',
    active,
    controllerOptions: fixture.dependencies,
  });

  return (
    <View style={styles.screen}>
      <View style={styles.banner}>
        <Text style={styles.bannerTitle}>LOCAL FIXTURE · NO REAL FUNDS</Text>
        <Text style={styles.bannerCopy}>
          Fixture swap uses disposable signing, API/RPC responses and in-memory pending storage.
          The connected wallet cannot sign or submit from this screen.
        </Text>
      </View>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.heading}>Swap verification cases</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.caseRow}>
          {SWAP_NATIVE_FIXTURE_CASES.map((item) => (
            <Pressable
              key={item.id}
              onPress={() => {
                setActive(true);
                onCase(item.id);
              }}
              style={[styles.caseChip, fixtureCase === item.id && styles.caseChipActive]}
              accessibilityRole="button"
              accessibilityLabel={`Fixture case: ${item.label}`}
              accessibilityState={{ selected: fixtureCase === item.id }}
            >
              <Text style={[styles.caseText, fixtureCase === item.id && styles.caseTextActive]}>
                {item.label}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
        <Text style={styles.selectedCase}>
          Case: {SWAP_NATIVE_FIXTURE_CASES.find((item) => item.id === fixtureCase)?.label}
        </Text>
        <View style={styles.controlRow}>
          <Pressable
            onPress={() => setActive((value) => !value)}
            style={[styles.control, !active && styles.controlActive]}
            accessibilityRole="button"
            accessibilityLabel={active ? 'Suspend fixture surface' : 'Resume fixture surface'}
          >
            <Text style={styles.controlText}>{active ? 'Suspend surface' : 'Resume surface'}</Text>
          </Pressable>
          {fixtureCase === 'unknown-recovery' ? (
            <Pressable
              onPress={() => {
                fixture.setPendingConfirmed();
                void controller.reconcilePending();
              }}
              style={styles.control}
              accessibilityRole="button"
              accessibilityLabel="Mark fixture pending swap confirmed and check status"
            >
              <Text style={styles.controlText}>Mark pending confirmed</Text>
            </Pressable>
          ) : null}
        </View>
        <WalletActionPanelView
          active={active}
          surfaceKey={`native-fixture:${fixtureCase}`}
          onBusyChange={setBusy}
          controller={controller}
          walletSheet={fixture.dependencies.walletSheet}
        />
        {!active ? <Text style={styles.note}>Fixture surface suspended; memory pending state is retained.</Text> : null}
        <Text style={styles.telemetry}>
          active={String(active)} · busy={String(busy)} · phase={controller.phase} · quote={counts.quote}{' '}
          · order={counts.order} · sign={counts.sign} · execute={counts.execute} · refresh={counts.refresh}
        </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.navy },
  content: { padding: 16, gap: 14, paddingBottom: 40 },
  banner: { margin: 12, padding: 12, borderRadius: 10, borderWidth: 2, borderColor: color.gold, backgroundColor: color.card },
  bannerTitle: { color: color.gold, fontSize: 13, fontWeight: '800', letterSpacing: 0.7 },
  bannerCopy: { color: color.text, fontSize: 12, lineHeight: 17, marginTop: 5 },
  heading: { color: color.text, fontSize: 20, fontWeight: '700' },
  caseRow: { gap: 8, paddingVertical: 2 },
  caseChip: { minHeight: 36, paddingHorizontal: 12, borderRadius: 18, borderWidth: 1, borderColor: color.border, justifyContent: 'center' },
  caseChipActive: { borderColor: color.gold, backgroundColor: color.card },
  caseText: { color: color.dim, fontSize: 12 },
  caseTextActive: { color: color.gold, fontWeight: '700' },
  selectedCase: { color: color.dim, fontSize: 12 },
  controlRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  control: { minHeight: 42, paddingHorizontal: 12, borderRadius: 9, backgroundColor: color.gold, justifyContent: 'center' },
  controlActive: { backgroundColor: color.card, borderWidth: 1, borderColor: color.gold },
  controlText: { color: color.navy, fontSize: 12, fontWeight: '700' },
  note: { color: color.dim, fontSize: 13, lineHeight: 19 },
  telemetry: { color: color.dim, fontFamily: 'monospace', fontSize: 11 },
  disabled: { flex: 1, backgroundColor: color.navy, alignItems: 'center', justifyContent: 'center', padding: 24 },
  disabledTitle: { color: color.text, fontSize: 18, fontWeight: '700' },
});
