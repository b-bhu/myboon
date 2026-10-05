import { SpotDataApiClient } from '@myboon/shared/spot';
import { resolveApiBaseUrl } from '@/lib/api';

/** Shared token balances for Wallet, Spot, and Meteora on the active app backend. */
export const walletBalanceClient = new SpotDataApiClient({
  apiBaseUrl: resolveApiBaseUrl(),
});
