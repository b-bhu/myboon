import { useLocalSearchParams } from 'expo-router';
import { MeteoraPoolPhaseTwoScreen } from '@/features/meteora/MeteoraPoolPhaseTwoScreen';
import { meteoraE2eClient } from '@/features/meteora/meteora.e2e-client';
import { MeteoraCreatePositionTestScreen } from '@/features/meteora/meteora-create-position-test-screen';

export default function MeteoraPoolRoute() {
  const { poolAddress, positionAddress, e2e, scenario } = useLocalSearchParams<{
    poolAddress: string;
    positionAddress?: string;
    e2e?: string;
    scenario?: string;
  }>();
  if (__DEV__ && e2e === 'form') {
    return <MeteoraCreatePositionTestScreen poolAddress={poolAddress ?? ''} scenario={scenario} />;
  }
  return (
    <MeteoraPoolPhaseTwoScreen
      poolAddress={poolAddress ?? ''}
      positionAddress={positionAddress || undefined}
      client={__DEV__ && e2e === '1' ? meteoraE2eClient : undefined}
    />
  );
}
