/**
 * Polymarket portfolio money card (#736), moved verbatim from
 * `polymarket.portfolio.tsx`: the Available / In picks / Ready breakdown bar
 * under the identity header. Presentational only — the screen passes the
 * #733 totals module's values. Pure move — no behaviour change.
 */

import { Text, View } from 'react-native';

import { truncateUsd } from '@/features/polymarket/formatPolymarketMoney';
import { styles } from '@/features/portfolio/polymarket/polymarket.portfolio.styles';
import type { PolymarketPortfolioTotals } from '@/features/portfolio/polymarket/polymarket.totals';

export interface PolymarketMoneyCardProps {
  cashBalance: number | null;
  activePicksValue: PolymarketPortfolioTotals['activePicksValue'];
  readyToCollect: PolymarketPortfolioTotals['readyToCollect'];
}

export function PolymarketMoneyCard({ cashBalance, activePicksValue, readyToCollect }: PolymarketMoneyCardProps) {
  return (
    <View style={styles.moneyCard}>
      <View pointerEvents="none" style={styles.moneyOrb} />
      <View style={styles.moneyBar}>
        {cashBalance !== null && cashBalance > 0 && (
          <View style={[styles.moneyBarSeg, styles.moneyBarAvailable, { flex: Math.max(cashBalance, 0.01) }]} />
        )}
        {activePicksValue !== null && activePicksValue > 0 && (
          <View style={[styles.moneyBarSeg, styles.moneyBarInPicks, { flex: Math.max(activePicksValue, 0.01) }]} />
        )}
        {readyToCollect > 0 && (
          <View style={[styles.moneyBarSeg, styles.moneyBarReady, { flex: Math.max(readyToCollect, 0.01) }]} />
        )}
        {((cashBalance ?? 0) <= 0 && (activePicksValue ?? 0) <= 0 && readyToCollect <= 0) && (
          <View style={[styles.moneyBarSeg, styles.moneyBarEmpty]} />
        )}
      </View>
      <View style={styles.moneyLegend}>
        <View style={[styles.moneyLegendItem, styles.moneyLegendAvailable]}>
          <View style={styles.moneyLegendHeading}>
            <View style={[styles.moneyLegendDot, styles.moneyBarAvailable]} />
            <Text style={styles.moneyLegendLabel}>Available</Text>
          </View>
          <Text style={styles.moneyLegendValue}>{truncateUsd(cashBalance)}</Text>
        </View>
        <View style={styles.moneyLegendItem}>
          <View style={styles.moneyLegendHeading}>
            <View style={[styles.moneyLegendDot, styles.moneyBarInPicks]} />
            <Text style={styles.moneyLegendLabel}>In picks</Text>
          </View>
          <Text style={styles.moneyLegendValue}>{truncateUsd(activePicksValue)}</Text>
        </View>
        <View style={styles.moneyLegendItem}>
          <View style={styles.moneyLegendHeading}>
            <View style={[styles.moneyLegendDot, styles.moneyBarReady]} />
            <Text style={styles.moneyLegendLabel}>Ready</Text>
          </View>
          <Text style={[styles.moneyLegendValue, readyToCollect > 0 && styles.moneyReadyValue]}>
            {truncateUsd(readyToCollect)}
          </Text>
        </View>
      </View>
    </View>
  );
}
