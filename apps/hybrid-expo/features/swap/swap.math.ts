const U64_MAX = (1n << 64n) - 1n;

function assertDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new Error('Token decimals are invalid.');
  }
}

export function parseUiAmountToAtomic(value: string, decimals: number): string {
  assertDecimals(decimals);
  const normalized = value.trim();
  if (!/^\d+(?:\.\d*)?$/.test(normalized)) {
    throw new Error('Enter an amount using digits and one decimal point.');
  }

  const [wholePart, fractionPart = ''] = normalized.split('.');
  if (fractionPart.length > decimals) {
    throw new Error(`This token supports at most ${decimals} decimal places.`);
  }

  const whole = wholePart.replace(/^0+(?=\d)/, '') || '0';
  const fraction = fractionPart.padEnd(decimals, '0');
  const atomic = BigInt(`${whole}${fraction}` || '0');
  if (atomic <= 0n) throw new Error('Enter an amount greater than zero.');
  if (atomic > U64_MAX) throw new Error('The amount is too large.');
  return atomic.toString();
}

export function formatAtomicAmount(value: string, decimals: number, maxFractionDigits = 6): string {
  assertDecimals(decimals);
  if (!/^\d+$/.test(value)) return '0';
  const atomic = BigInt(value);
  if (decimals === 0) return atomic.toString();

  const base = 10n ** BigInt(decimals);
  const whole = atomic / base;
  const fraction = (atomic % base).toString().padStart(decimals, '0');
  const shown = fraction.slice(0, Math.max(0, Math.min(decimals, maxFractionDigits))).replace(/0+$/, '');
  return shown ? `${whole}.${shown}` : whole.toString();
}

export function percentageOfAtomic(balanceAtomic: string, percent: 25 | 50 | 75 | 100): string {
  if (!/^\d+$/.test(balanceAtomic)) throw new Error('Balance is invalid.');
  if (percent === 100) return BigInt(balanceAtomic).toString();
  return ((BigInt(balanceAtomic) * BigInt(percent)) / 100n).toString();
}

export function parseSlippagePercentToBps(value: string): number {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d{0,2})?$/.test(normalized)) {
    throw new Error('Slippage can use at most two decimal places.');
  }
  const [whole, fraction = ''] = normalized.split('.');
  const bps = Number(BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0') || '0'));
  if (bps < 0 || bps > 5_000) throw new Error('Slippage must be between 0% and 50%.');
  return bps;
}

export function isAtomicAmountAtLeast(balanceAtomic: string | undefined, amountAtomic: string): boolean {
  if (!balanceAtomic || !/^\d+$/.test(balanceAtomic) || !/^\d+$/.test(amountAtomic)) return false;
  return BigInt(balanceAtomic) >= BigInt(amountAtomic);
}
