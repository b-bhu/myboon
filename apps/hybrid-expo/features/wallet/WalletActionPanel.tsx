import { SwapComposer } from '@/features/swap/components/SwapComposer';
import { useSwapController, type SwapControllerOptions } from '@/features/swap/useSwapController';

// Wallet and every routed Spot trade render the same controlled composer.
export { SwapComposer as WalletActionPanelView } from '@/features/swap/components/SwapComposer';

export function WalletActionPanel({ active, controllerActive = active, surfaceKey, onBusyChange, controllerOptions }: {
  active: boolean;
  controllerActive?: boolean;
  surfaceKey: string;
  onBusyChange: (busy: boolean) => void;
  controllerOptions?: SwapControllerOptions['controllerOptions'];
}) {
  const controller = useSwapController({ mode: 'swap', active: controllerActive, controllerOptions });
  return <SwapComposer active={active} surfaceKey={surfaceKey} onBusyChange={onBusyChange}
    controller={controller} walletSheet={controllerOptions?.walletSheet} />;
}
