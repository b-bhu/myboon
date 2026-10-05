import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { MeteoraPhaseTwoAdapter, MeteoraPhaseTwoPreview } from './meteora.form';
import { MeteoraPoolPhaseTwoScreen, type MeteoraScreenWalletOverride } from './MeteoraPoolPhaseTwoScreen';
import { meteoraE2eClient } from './meteora.e2e-client';
import { snapRangeToPoolState } from '@myboon/shared/meteora';
import { estimateAutoFillAmounts } from './meteora.auto-fill';
import { fixtureDecimalToAtomic, getFixtureSdkStrategyAllocation } from './meteora.fixture-allocation';
import { getMeteoraFixturePoolSnapshot, type MeteoraFixturePoolMovement, type MeteoraFixtureScenario } from './meteora.fixture-state';

type Scenario = MeteoraFixtureScenario;

const FIXTURE_COSTS = [
  { label: 'Position rent', value: '0.05740608 SOL', refundable: true },
  { label: 'Position extension rent', value: '0 SOL', refundable: true },
  { label: 'Bin-array rent', value: '0 SOL' },
  { label: 'Bin-array extension rent', value: '0 SOL' },
  { label: 'Token account rent', value: '0 SOL', refundable: true },
  { label: 'Maximum network fee', value: '0.00005 SOL' },
  { label: 'Total native required', value: '0.05745608 SOL' },
] as const;

const scenarios: Record<Scenario, { x: string; y: string }> = {
  balanced: { x: '3', y: '1000' },
  'zero-usdc': { x: '0.07606', y: '0' },
  'low-native': { x: '0.01', y: '1000' },
  'cost-error': { x: '3', y: '1000' },
  'quote-error': { x: '3', y: '1000' },
  'quote-delay': { x: '3', y: '1000' },
  'sdk-offset': { x: '3', y: '1000' },
  'sdk-move': { x: '3', y: '1000' },
};

function fixtureAdapter(scenario: Scenario, counter: () => void, movement: MeteoraFixturePoolMovement): MeteoraPhaseTwoAdapter {
  // Deliberately differs from the e2e API pool price in this scenario so
  // the screen proves it uses this SDK snapshot for bins, validation and chart.
  const factor = 1.0004;
  const snapshot = () => getMeteoraFixturePoolSnapshot(scenario, movement);
  const price = (offset: number) => String(Number(snapshot().currentPrice) * factor ** offset);
  return {
    async getDefaultRange() {
      const { currentPrice, activeBinId } = snapshot();
      return {
        requestedMinPrice: price(-34), requestedMaxPrice: price(35), binCount: 70, currentPrice,
        yOnlyMinPrice: price(-69), xOnlyMaxPrice: price(69), activeBinId,
      };
    },
    async getWalletBalances() { return scenarios[scenario]; },
    async getNativeBalance() { return scenarios[scenario].x; },
    async getPositionCostEstimate() {
      if (scenario === 'cost-error') throw new Error('Test native cost estimate failed.');
      if (scenario === 'quote-delay') await new Promise((resolve) => setTimeout(resolve, 900));
      return { costs: [...FIXTURE_COSTS], nativeReserve: '0.05745608', transactionCount: 1 };
    },
    async getPoolLiquidity(_poolAddress, minBinId, maxBinId) {
      const { currentPrice, activeBinId } = snapshot();
      // Return only the requested canonical window; a chart translation must
      // therefore issue a fresh read instead of drawing stale active±128 data.
      return {
        activeBinId,
        activePrice: currentPrice,
        bins: Array.from({ length: maxBinId - minBinId + 1 }, (_, index) => {
          const binId = minBinId + index;
          const offset = binId - activeBinId;
          return {
            binId,
            price: price(offset),
            xAtomic: String(Math.max(0, 70 - Math.abs(offset)) * 1_000_000),
            yAtomic: String((Math.abs(offset) + 1) * 100_000),
          };
        }),
      };
    },
    async preparePosition(context, draft, onAutoFillQuote) {
      counter();
      if (scenario === 'quote-error' && draft.autoFill) throw new Error('Test quote failed. Source amount is unchanged.');
      // Deliberately longer than browser polling so turning Auto-Fill off can
      // prove an in-flight quote cannot materialize a stale counterpart.
      if (scenario === 'quote-delay' && draft.autoFill) await new Promise((resolve) => setTimeout(resolve, 3_000));
      const { currentPrice, activeBinId } = snapshot();
      const state = {
        poolAddress: context.pool.address, activeBinId, activePrice: currentPrice, binStep: context.pool.binStep,
        tokenX: context.pool.tokenX, tokenY: context.pool.tokenY, refreshedAt: new Date().toISOString(),
      };
      const range = snapRangeToPoolState(state, { kind: 'manual', minPrice: draft.requestedMinPrice, maxPrice: draft.requestedMaxPrice });
      const estimate = estimateAutoFillAmounts({ draft, currentPrice, binStep: context.pool.binStep, tokenXDecimals: 9, tokenYDecimals: 6 });
      if (draft.autoFill && estimate) onAutoFillQuote?.(estimate);
      const requiredAmountX = estimate?.amountX ?? (draft.amountX || '0');
      const requiredAmountY = estimate?.amountY ?? (draft.amountY || '0');
      const preview: MeteoraPhaseTwoPreview = {
        id: `test-${Date.now()}`, kind: 'position', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30_000).toISOString(),
        currentPrice, activeBinId, poolState: state, requestedMinPrice: range.requestedMinPrice, requestedMaxPrice: range.requestedMaxPrice, executableMinPrice: range.executableMinPrice, executableMaxPrice: range.executableMaxPrice,
        minBinId: range.minBinId, maxBinId: range.maxBinId, binCount: range.binCount,
        requiredAmountX, requiredAmountY,
        spendableBalanceX: scenarios[scenario].x, spendableBalanceY: scenarios[scenario].y, transactionCount: 1,
        strategyAllocation: getFixtureSdkStrategyAllocation({
          activeBinId, binStep: context.pool.binStep, minBinId: range.minBinId, maxBinId: range.maxBinId,
          amountXAtomic: fixtureDecimalToAtomic(requiredAmountX, context.pool.tokenX.decimals),
          amountYAtomic: fixtureDecimalToAtomic(requiredAmountY, context.pool.tokenY.decimals), strategy: draft.strategy,
        }),
        costs: scenario === 'cost-error'
          ? [{ label: 'Native cost estimate', value: 'Unavailable' }]
          : [...FIXTURE_COSTS],
        // Exercise the actual-preview unknown-cost gate as well as the
        // independent estimate failure. This fixture cannot execute.
        nativeReserve: scenario === 'cost-error' ? null : '0.05745608',
        warnings: [], canExecute: true, walletAddress: context.walletAddress, network: 'mainnet-beta',
      };
      return preview;
    },
    async prepareLimitOrder() { throw new Error('Test fixture does not provide limit orders.'); },
    async execute() { throw new Error('Test fixture refuses execution and cannot sign or submit transactions.'); },
  };
}

const testWallet = {
  connected: true,
  address: '11111111111111111111111111111111',
  source: 'web',
  connection: null,
  isPreparing: false,
  signAndSendTransaction: async () => { throw new Error('Test fixture refuses signing and submission.'); },
} as unknown as MeteoraScreenWalletOverride;

/** Dev-only, read-only browser fixture. It never exposes a signing path. */
export function MeteoraCreatePositionTestScreen({ poolAddress, scenario = 'balanced' }: { poolAddress: string; scenario?: string }) {
  const initialScenario: Scenario = scenario in scenarios ? scenario as Scenario : 'balanced';
  const [activeScenario, setActiveScenario] = useState<Scenario>(initialScenario);
  const [prepareCalls, setPrepareCalls] = useState(0);
  const [liquidityRefreshSignal, setLiquidityRefreshSignal] = useState(0);
  const movementRef = useRef<MeteoraFixturePoolMovement>({ moved: false });
  const movementTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const adapter = useMemo(() => fixtureAdapter(activeScenario, () => setPrepareCalls((value) => value + 1), movementRef.current), [activeScenario]);
  useEffect(() => () => {
    if (movementTimerRef.current) clearTimeout(movementTimerRef.current);
  }, []);
  return (
    <View style={styles.root}>
      <View style={styles.banner} accessibilityRole="alert">
        <Text style={styles.bannerText}>Test data only · execution and signing are disabled · previews: {prepareCalls}</Text>
        <View style={styles.options}>{(Object.keys(scenarios) as Scenario[]).map((key) => (
          <Pressable key={key} onPress={() => {
            if (movementTimerRef.current) clearTimeout(movementTimerRef.current);
            movementRef.current.moved = false;
            setActiveScenario(key);
          }} accessibilityRole="button" style={styles.option}>
            <Text style={styles.optionText}>{key}</Text>
          </Pressable>
        ))}</View>
        {activeScenario === 'sdk-move' ? (
          <Pressable
            onPress={() => {
              if (movementTimerRef.current) clearTimeout(movementTimerRef.current);
              movementTimerRef.current = setTimeout(() => {
                movementRef.current.moved = true;
                setLiquidityRefreshSignal((value) => value + 1);
              }, 900);
            }}
            accessibilityRole="button"
            accessibilityLabel="Test pool movement"
            testID="meteora-fixture-move-pool"
            style={styles.option}
          >
            <Text style={styles.optionText}>Move pool after review</Text>
          </Pressable>
        ) : null}
      </View>
      <MeteoraPoolPhaseTwoScreen poolAddress={poolAddress} client={meteoraE2eClient} adapter={adapter} walletOverride={testWallet} liquidityRefreshSignal={liquidityRefreshSignal} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 }, banner: { padding: 10, gap: 6, backgroundColor: '#18243A' }, bannerText: { color: '#DCE8FF', fontSize: 12 },
  options: { flexDirection: 'row', gap: 8 }, option: { paddingHorizontal: 8, paddingVertical: 5, borderRadius: 6, backgroundColor: '#283A5A' }, optionText: { color: '#FFFFFF', fontSize: 12 },
});
