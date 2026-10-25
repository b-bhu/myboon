import { WAITLIST_MODE } from '@/features/waitlist/waitlist.mode';
import { WaitlistProfileScreen } from '@/features/waitlist/WaitlistProfileScreen';
import { PhoenixProfileScreen } from '@/features/perps/PhoenixProfileScreen';

export default function PhoenixProfileRoute() {
  // Waitlist build (#432): profile has no wallet parts.
  if (WAITLIST_MODE) return <WaitlistProfileScreen />;
  return <PhoenixProfileScreen />;
}
