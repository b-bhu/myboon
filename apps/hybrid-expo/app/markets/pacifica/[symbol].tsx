import { useLocalSearchParams } from 'expo-router';
import { PacificaMarketDetailScreen } from '@/features/perps/PacificaMarketDetailScreen';

export default function PacificaSymbolRoute() {
  const { symbol } = useLocalSearchParams<{ symbol: string }>();
  return <PacificaMarketDetailScreen symbol={symbol ?? 'BTC'} />;
}
