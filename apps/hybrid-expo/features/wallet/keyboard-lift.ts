/**
 * #805 — the pure keyboard-lift rule for the Wallet's action panel.
 *
 * Given positions measured at run time, the lift is exactly the overlap that
 * pushes the slider row's bottom edge up to the keyboard's top edge — never
 * more (the panel would jump past the keyboard) and never less. The lift stops
 * at `amountTopY - safeTopY` so the amount field always wins on very small
 * screens; the slider may stay partly covered there.
 */

export type WalletKeyboardLiftInput = {
  /** Window Y of the keyboard's top edge (screen height minus the live height). */
  keyboardTopY: number;
  /** Measured window Y of the slider row's bottom edge, at rest. */
  sliderBottomY: number;
  /** Measured window Y of the amount field's top edge, at rest. */
  amountTopY: number;
  /** Top safe-area inset. */
  safeTopY: number;
};

export function walletKeyboardLiftPx({
  keyboardTopY,
  sliderBottomY,
  amountTopY,
  safeTopY,
}: WalletKeyboardLiftInput): number {
  // Nothing measured, or garbage in: no lift, and never a negative or NaN one.
  if (
    !Number.isFinite(keyboardTopY) ||
    !Number.isFinite(sliderBottomY) ||
    !Number.isFinite(amountTopY) ||
    !Number.isFinite(safeTopY)
  ) {
    return 0;
  }
  const overlap = sliderBottomY - keyboardTopY;
  if (overlap <= 0) return 0;
  if (keyboardTopY < 0 || sliderBottomY < 0 || amountTopY < 0 || safeTopY < 0) return 0;
  const headroom = Math.max(0, amountTopY - safeTopY);
  return Math.min(overlap, headroom);
}
