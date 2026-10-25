import { WAITLIST_MODE } from '@/features/waitlist/waitlist.mode';
import { WaitlistProfileScreen } from '@/features/waitlist/WaitlistProfileScreen';
import { PacificaProfileScreen } from '@/features/perps/PacificaProfileScreen';

export default function PacificaProfileRoute() {
  // Waitlist build (#432): profile has no wallet parts.
  if (WAITLIST_MODE) return <WaitlistProfileScreen />;
  return <PacificaProfileScreen />;
}
