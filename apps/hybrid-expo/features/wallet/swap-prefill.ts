// #906: puts a Spot token in the Swap pay card using only the controller's
// public API (the hook only loads the token for requestedMint in Swap mode).
export type SwapPrefillStep = 'open-picker' | 'select' | null;

export function nextSwapPrefillStep(input: {
  prefillMint: string | null;
  loadedMint: string | null;
  payMint: string;
  phase: string;
  pickerSide: 'input' | 'output';
}): SwapPrefillStep {
  const { prefillMint, loadedMint, payMint, phase, pickerSide } = input;
  if (!prefillMint || loadedMint !== prefillMint || payMint === prefillMint) return null;
  if (phase === 'picker') return pickerSide === 'input' ? 'select' : null;
  return phase === 'compose' ? 'open-picker' : null;
}
