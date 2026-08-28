import { useLocalSearchParams } from 'expo-router';
import { PhoenixMarketDetailScreen } from '@/features/perps/PhoenixMarketDetailScreen';

export default function PhoenixMarketSymbolRoute() {
  const params = useLocalSearchParams<{ symbol?: string | string[] }>();
  const symbol = firstParam(params.symbol) ?? 'BTC-PERP';
  return <PhoenixMarketDetailScreen symbol={symbol} />;
}

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
