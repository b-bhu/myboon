import { SpotScreen } from '@/features/spot/SpotScreen';
import { WaitlistScreen } from '@/features/waitlist/WaitlistScreen';
import { WAITLIST_MODE } from '@/features/waitlist/waitlist.mode';

// Waitlist build (#432): Spot is wallet-only, so it becomes the waitlist.
export default WAITLIST_MODE ? WaitlistScreen : SpotScreen;
