import SwapScreen from '@/features/swap/SwapScreen';
import { WaitlistScreen } from '@/features/waitlist/WaitlistScreen';
import { WAITLIST_MODE } from '@/features/waitlist/waitlist.mode';

// Waitlist build (#432): swap becomes the waitlist.
export default WAITLIST_MODE ? WaitlistScreen : SwapScreen;
