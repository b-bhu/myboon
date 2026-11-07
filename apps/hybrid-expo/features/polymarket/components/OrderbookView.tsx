import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import type { Orderbook } from '@/features/polymarket/polymarket.types';
import { semantic, tokens } from '@/theme';

interface OrderbookViewProps {
  book: Orderbook | null;
  loading: boolean;
}

function formatProbability(price: number): string {
  return `${Math.round(price * 100)}%`;
}

function formatShares(size: number): string {
  if (size >= 1000) return `${(size / 1000).toFixed(1)}K`;
  return size.toFixed(2);
}

function formatTotal(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toFixed(2)}`;
}

export function OrderbookView({ book, loading }: OrderbookViewProps) {
  if (loading) {
    return (
      <View style={styles.loadingWrap}>
        <ActivityIndicator size="small" color={semantic.text.faint} />
      </View>
    );
  }

  if (!book || (book.asks.length === 0 && book.bids.length === 0)) {
    return (
      <View style={styles.loadingWrap}>
        <Text style={styles.emptyText}>No orderbook data</Text>
      </View>
    );
  }

  const allSizes = [...book.asks.map((l) => l.size), ...book.bids.map((l) => l.size)];
  const maxSize = Math.max(...allSizes, 1);

  // Pick 6 asks nearest spread (lowest prices), display highest-at-top so lowest is near spread row
  const asks = [...book.asks].sort((a, b) => a.price - b.price).slice(0, 6).reverse();
  // Pick 6 bids nearest spread (highest prices), display highest-at-top (near spread row)
  const bids = [...book.bids].sort((a, b) => b.price - a.price).slice(0, 6);

  let runningAskTotal = 0;
  let runningBidTotal = 0;

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerText}>Price</Text>
        <Text style={[styles.headerText, styles.headerCenter]}>Shares</Text>
        <Text style={[styles.headerText, styles.headerRight]}>Total</Text>
      </View>

      {/* Asks */}
      {asks.map((level, i) => {
        runningAskTotal += level.size * level.price;
        const depthPct = (level.size / maxSize) * 100;
        return (
          <View key={`ask-${i}`} style={styles.row}>
            <View style={[styles.depthBar, styles.depthAsk, { width: `${depthPct}%` }]} />
            <Text style={[styles.price, styles.askPrice]}>{formatProbability(level.price)}</Text>
            <Text style={[styles.shares]}>{formatShares(level.size)}</Text>
            <Text style={[styles.total]}>{formatTotal(runningAskTotal)}</Text>
          </View>
        );
      })}

      {/* Spread */}
      <View style={styles.spreadRow}>
        <Text style={styles.spreadLabel}>
          Last: {book.lastPrice !== null ? formatProbability(book.lastPrice) : '--'}
        </Text>
        <Text style={styles.spreadVal}>
          Spread: {book.spread !== null ? formatProbability(book.spread) : '--'}
        </Text>
      </View>

      {/* Bids */}
      {bids.map((level, i) => {
        runningBidTotal += level.size * level.price;
        const depthPct = (level.size / maxSize) * 100;
        return (
          <View key={`bid-${i}`} style={styles.row}>
            <View style={[styles.depthBar, styles.depthBid, { width: `${depthPct}%` }]} />
            <Text style={[styles.price, styles.bidPrice]}>{formatProbability(level.price)}</Text>
            <Text style={[styles.shares]}>{formatShares(level.size)}</Text>
            <Text style={[styles.total]}>{formatTotal(runningBidTotal)}</Text>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    fontFamily: 'monospace',
  },
  loadingWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyText: {
    fontFamily: 'monospace',
    fontSize: 10,
    color: semantic.text.faint,
  },
  header: {
    flexDirection: 'row',
    paddingVertical: 4,
  },
  headerText: {
    flex: 1,
    fontFamily: 'monospace',
    fontSize: 8,
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: semantic.text.dim,
  },
  headerCenter: { textAlign: 'center' },
  headerRight: { textAlign: 'right' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 3,
    position: 'relative',
  },
  depthBar: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    right: 0,
    borderRadius: 3,
  },
  depthAsk: {
    backgroundColor: 'rgba(217,83,79,0.08)',
  },
  depthBid: {
    backgroundColor: 'rgba(74,140,111,0.08)',
  },
  price: {
    flex: 1,
    fontFamily: 'monospace',
    fontSize: 10,
    fontWeight: '700',
  },
  askPrice: { color: semantic.sentiment.negative },
  bidPrice: { color: semantic.sentiment.positive },
  shares: {
    flex: 1,
    textAlign: 'center',
    fontFamily: 'monospace',
    fontSize: 10,
    color: semantic.text.dim,
  },
  total: {
    flex: 1,
    textAlign: 'right',
    fontFamily: 'monospace',
    fontSize: 10,
    color: semantic.text.dim,
  },
  spreadRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 6,
    marginVertical: 2,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: semantic.polymarket.rowBorderSoft,
  },
  spreadLabel: {
    fontFamily: 'monospace',
    fontSize: 8,
    color: semantic.text.dim,
  },
  spreadVal: {
    fontFamily: 'monospace',
    fontSize: 9,
    color: semantic.text.primary,
  },
});
