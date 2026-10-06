import { SwapVerificationScreen } from '@/features/swap/SwapVerificationScreen';
import { useLocalSearchParams } from 'expo-router';

export default function DevSwapVerificationRoute() {
  const params = useLocalSearchParams<{ case?: string }>();
  const fixtureCase = Array.isArray(params.case) ? params.case[0] : params.case;
  return <SwapVerificationScreen key={fixtureCase ?? 'solana'} initialCase={fixtureCase} />;
}
