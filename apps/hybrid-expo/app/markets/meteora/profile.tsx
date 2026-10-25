import { WAITLIST_MODE } from '@/features/waitlist/waitlist.mode';
import { WaitlistProfileScreen } from '@/features/waitlist/WaitlistProfileScreen';
import { MeteoraProfileScreen } from '@/features/meteora/MeteoraProfileScreen';

export default function MeteoraProfileRoute() {
  // Waitlist build (#432): profile has no wallet parts.
  if (WAITLIST_MODE) return <WaitlistProfileScreen />;
  return <MeteoraProfileScreen />;
}
