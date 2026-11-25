import { useEffect, useRef } from 'react';
import { SwapComposer } from '@/features/swap/components/SwapComposer';
import { useSwapController, type SwapControllerOptions } from '@/features/swap/useSwapController';
import { nextSwapPrefillStep } from '@/features/wallet/swap-prefill';

// Wallet and every routed Spot trade render the same controlled composer.
export { SwapComposer as WalletActionPanelView } from '@/features/swap/components/SwapComposer';

/** A Spot token the Wallet's Swap mode opens with as the pay card (#906). */
export type SwapPrefill = { mint: string; source: 'spot' };

export function WalletActionPanel({ active, controllerActive = active, surfaceKey, onBusyChange, controllerOptions, swapPrefill = null }: {
  active: boolean;
  controllerActive?: boolean;
  surfaceKey: string;
  onBusyChange: (busy: boolean) => void;
  controllerOptions?: SwapControllerOptions['controllerOptions'];
  swapPrefill?: SwapPrefill | null;
}) {
  const prefillMint = swapPrefill?.mint ?? null;
  const controller = useSwapController({
    mode: 'swap',
    active: controllerActive,
    requestedMint: prefillMint ?? undefined,
    controllerOptions,
  });
  // The hook loads the token for requestedMint; move it into the pay side once.
  const appliedMint = useRef<string | null>(null);
  const step = appliedMint.current === prefillMint ? null : nextSwapPrefillStep({
    prefillMint,
    loadedMint: controller.selectedToken?.address ?? null,
    payMint: controller.inputToken.address,
    phase: controller.phase,
    pickerSide: controller.pickerSide,
  });
  const { openPicker, selectToken, selectedToken } = controller;
  useEffect(() => {
    if (prefillMint === null) appliedMint.current = null;
    if (step === 'open-picker') openPicker('input');
    else if (step === 'select' && selectedToken) {
      appliedMint.current = prefillMint;
      selectToken(selectedToken);
    }
  }, [step, openPicker, selectToken, selectedToken, prefillMint]);
  return <SwapComposer active={active} surfaceKey={surfaceKey} onBusyChange={onBusyChange}
    controller={controller} walletSheet={controllerOptions?.walletSheet} inWallet
    payFromSpot={prefillMint !== null} />;
}
