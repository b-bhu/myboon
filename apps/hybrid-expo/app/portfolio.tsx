import { CombinedPortfolioScreen } from '@/features/wallet/CombinedPortfolioScreen';

/**
 * Combined portfolio across every venue (issue #653). The per-venue scoped
 * view with its three tabs is D2 (#657); until then a venue group here opens
 * that venue's existing profile screen.
 */
export default function PortfolioRoute() {
  return <CombinedPortfolioScreen />;
}
