/** String decimal helpers so size/price math does not go through IEEE floats. */

export function parseDecimal(value: string): { neg: boolean; digits: bigint; scale: number } {
  const trimmed = value.trim();
  if (!/^[-+]?(?:\d+)(?:\.\d+)?$/.test(trimmed)) {
    throw new Error(`not a decimal: ${value}`);
  }
  const neg = trimmed.startsWith("-");
  const unsigned = trimmed.startsWith("-") || trimmed.startsWith("+") ? trimmed.slice(1) : trimmed;
  const [whole = "0", frac = ""] = unsigned.split(".");
  return { neg, digits: BigInt(`${whole}${frac}` || "0"), scale: frac.length };
}

function scaleDigits(parts: { neg: boolean; digits: bigint; scale: number }, scale: number): bigint {
  const signed = parts.neg ? -parts.digits : parts.digits;
  return signed * 10n ** BigInt(scale - parts.scale);
}

export function addDecimal(a: string, b: string): string {
  const left = parseDecimal(a);
  const right = parseDecimal(b);
  const scale = Math.max(left.scale, right.scale);
  return formatDecimal(scaleDigits(left, scale) + scaleDigits(right, scale), scale);
}

export function subDecimal(a: string, b: string): string {
  const left = parseDecimal(a);
  const right = parseDecimal(b);
  const scale = Math.max(left.scale, right.scale);
  return formatDecimal(scaleDigits(left, scale) - scaleDigits(right, scale), scale);
}

export function mulDecimal(a: string, b: string): string {
  const left = parseDecimal(a);
  const right = parseDecimal(b);
  const signed =
    (left.neg ? -left.digits : left.digits) * (right.neg ? -right.digits : right.digits);
  return formatDecimal(signed, left.scale + right.scale);
}

export function absDecimal(value: string): string {
  return value.trim().startsWith("-") ? value.trim().slice(1) : value.trim();
}

export function cmpDecimal(a: string, b: string): number {
  const diff = subDecimal(a, b);
  const parsed = parseDecimal(diff);
  if (parsed.digits === 0n) return 0;
  return parsed.neg ? -1 : 1;
}

export function isZeroDecimal(value: string): boolean {
  return parseDecimal(value).digits === 0n;
}

export function signDecimal(value: string): -1 | 0 | 1 {
  const parsed = parseDecimal(value);
  if (parsed.digits === 0n) return 0;
  return parsed.neg ? -1 : 1;
}

export function formatDecimal(digits: bigint, scale: number): string {
  const neg = digits < 0n;
  let raw = (neg ? -digits : digits).toString();
  if (scale === 0) return `${neg ? "-" : ""}${raw}`;
  if (raw.length <= scale) raw = raw.padStart(scale + 1, "0");
  const cut = raw.length - scale;
  const frac = raw.slice(cut).replace(/0+$/, "");
  const whole = raw.slice(0, cut);
  return `${neg ? "-" : ""}${whole}${frac.length > 0 ? `.${frac}` : ""}`;
}

export function formatFixed(value: string, digits: number): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  });
}

export function formatUsd(value: string, digits = 2): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

export function formatPctFromDecimal(value: string, digits = 2): string {
  const n = Number(value) * 100;
  if (!Number.isFinite(n)) return value;
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}%`;
}

export function formatSignedUsd(value: string, digits = 2): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  const sign = n > 0 ? "+" : n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}
