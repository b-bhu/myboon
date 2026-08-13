/**
 * Unit tests for lib/format.ts — every branch of every formatter, including
 * null/undefined/NaN/0/negative/string-numeric inputs, ported against the
 * exact threshold expectations of the four legacy implementations this file
 * consolidates (perps.public-api.ts formatPrice/formatChange/formatFunding,
 * phoenix.api.ts formatPhoenixPrice/formatPhoenixPercent/formatPhoenixRate,
 * and MeteoraPoolsScreen.tsx's private formatUsdCompact/formatFee/
 * formatUsdAccessible/formatCount).
 *
 * Run: pnpm --filter hybrid-expo test:format
 *
 * PURE module under test, no react-native — safe for tsx --test.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  NO_DATA,
  formatPrice,
  formatPercent,
  formatRate,
  formatUsdCompact,
  formatFee,
  formatUsdAccessible,
  formatCount,
} from './format';

describe('NO_DATA', () => {
  it('is the single em-dash glyph', () => {
    assert.equal(NO_DATA, '—');
  });
});

describe('formatPrice', () => {
  it('returns NO_DATA for null, undefined, NaN, 0, and negative', () => {
    assert.equal(formatPrice(null), NO_DATA);
    assert.equal(formatPrice(undefined), NO_DATA);
    assert.equal(formatPrice(NaN), NO_DATA);
    assert.equal(formatPrice(0), NO_DATA);
    assert.equal(formatPrice(-5), NO_DATA);
    assert.equal(formatPrice(Infinity), NO_DATA);
    assert.equal(formatPrice(-Infinity), NO_DATA);
  });

  it('formats >=1000 with locale grouping and no decimals', () => {
    assert.equal(formatPrice(1000), '$1,000');
    assert.equal(formatPrice(123456.789), '$123,457');
  });

  it('formats >=1 and <1000 with 3 decimals', () => {
    assert.equal(formatPrice(1), '$1.000');
    assert.equal(formatPrice(999.9999), '$1000.000');
    assert.equal(formatPrice(42.5), '$42.500');
  });

  it('formats >=0.001 and <1 with 6 decimals', () => {
    assert.equal(formatPrice(0.001), '$0.001000');
    assert.equal(formatPrice(0.5), '$0.500000');
  });

  it('formats <0.001 (but >0) as exponential with 3 decimals', () => {
    assert.equal(formatPrice(0.0009), `$${(0.0009).toExponential(3)}`);
    assert.equal(formatPrice(0.00000001), `$${(0.00000001).toExponential(3)}`);
  });

  it('accepts numeric strings', () => {
    assert.equal(formatPrice('1500'), '$1,500');
    assert.equal(formatPrice('0.5'), '$0.500000');
    assert.equal(formatPrice('not-a-number'), NO_DATA);
  });
});

describe('formatPercent', () => {
  it('returns NO_DATA for null, undefined, and non-finite', () => {
    assert.equal(formatPercent(null), NO_DATA);
    assert.equal(formatPercent(undefined), NO_DATA);
    assert.equal(formatPercent(NaN), NO_DATA);
    assert.equal(formatPercent(Infinity), NO_DATA);
  });

  it('signs positive and zero values with a leading +', () => {
    assert.equal(formatPercent(0), '+0.00%');
    assert.equal(formatPercent(5), '+5.00%');
    assert.equal(formatPercent(5.019), '+5.02%');
  });

  it('signs negative values with a leading -', () => {
    assert.equal(formatPercent(-5), '-5.00%');
    assert.equal(formatPercent(-0.1), '-0.10%');
  });

  it('respects a custom decimals param, default 2', () => {
    assert.equal(formatPercent(1.23456, 4), '+1.2346%');
    assert.equal(formatPercent(-1.23456, 0), '-1%');
  });

  it('accepts numeric strings', () => {
    assert.equal(formatPercent('5'), '+5.00%');
    assert.equal(formatPercent('bad'), NO_DATA);
  });
});

describe('formatRate', () => {
  it('returns NO_DATA for null, undefined, and non-finite', () => {
    assert.equal(formatRate(null), NO_DATA);
    assert.equal(formatRate(undefined), NO_DATA);
    assert.equal(formatRate(NaN), NO_DATA);
  });

  it('multiplies by 100 and formats with 4 decimals, signed', () => {
    assert.equal(formatRate(0.0001), '+0.0100%');
    assert.equal(formatRate(0), '+0.0000%');
    assert.equal(formatRate(-0.0001), '-0.0100%');
  });

  it('accepts numeric strings', () => {
    assert.equal(formatRate('0.0001'), '+0.0100%');
    assert.equal(formatRate('nope'), NO_DATA);
  });
});

describe('formatUsdCompact', () => {
  it('returns NO_DATA for null, undefined, non-finite, zero, and negative', () => {
    assert.equal(formatUsdCompact(null), NO_DATA);
    assert.equal(formatUsdCompact(undefined), NO_DATA);
    assert.equal(formatUsdCompact(NaN), NO_DATA);
    assert.equal(formatUsdCompact(0), NO_DATA);
    assert.equal(formatUsdCompact(-100), NO_DATA);
  });

  it('formats billions, millions, and thousands with 1 decimal', () => {
    assert.equal(formatUsdCompact(2_500_000_000), '$2.5B');
    assert.equal(formatUsdCompact(1_200_000), '$1.2M');
    assert.equal(formatUsdCompact(4_300), '$4.3K');
  });

  it('formats amounts >=100 and <1000 with 0 decimals', () => {
    assert.equal(formatUsdCompact(500), '$500');
    assert.equal(formatUsdCompact(999), '$999');
  });

  it('formats amounts <100 with 2 decimals', () => {
    assert.equal(formatUsdCompact(42.567), '$42.57');
    assert.equal(formatUsdCompact(0.5), '$0.50');
  });

  it('accepts numeric strings', () => {
    assert.equal(formatUsdCompact('1000'), '$1.0K');
    assert.equal(formatUsdCompact('garbage'), NO_DATA);
  });
});

describe('formatFee', () => {
  it('returns NO_DATA for null, undefined, and non-finite', () => {
    assert.equal(formatFee(null), NO_DATA);
    assert.equal(formatFee(undefined), NO_DATA);
    assert.equal(formatFee(NaN), NO_DATA);
  });

  it('uses 3 decimals under 0.1 and trims trailing zeros', () => {
    assert.equal(formatFee(0.04), '0.04%');
    assert.equal(formatFee(0.001), '0.001%');
    assert.equal(formatFee(0.05), '0.05%');
  });

  it('uses 2 decimals at or above 0.1 and trims trailing zeros', () => {
    assert.equal(formatFee(0.1), '0.1%');
    assert.equal(formatFee(1), '1%');
    assert.equal(formatFee(2.5), '2.5%');
    assert.equal(formatFee(2.25), '2.25%');
  });

  it('accepts numeric strings', () => {
    assert.equal(formatFee('0.04'), '0.04%');
  });
});

describe('formatUsdAccessible', () => {
  it("returns the word 'Unavailable' (never NO_DATA) for no-data inputs", () => {
    assert.equal(formatUsdAccessible(null), 'Unavailable');
    assert.equal(formatUsdAccessible(undefined), 'Unavailable');
    assert.equal(formatUsdAccessible(NaN), 'Unavailable');
    assert.notEqual(formatUsdAccessible(null), NO_DATA);
  });

  it('spells out currency with "US dollars" suffix', () => {
    const result = formatUsdAccessible(1234.5);
    assert.match(result, /US dollars$/);
    assert.match(result, /\$1,234\.50/);
  });

  it('accepts numeric strings', () => {
    assert.match(formatUsdAccessible('50'), /\$50\.00 US dollars/);
  });
});

describe('formatCount', () => {
  it('returns NO_DATA for null, undefined, and non-finite', () => {
    assert.equal(formatCount(null), NO_DATA);
    assert.equal(formatCount(undefined), NO_DATA);
    assert.equal(formatCount(NaN), NO_DATA);
  });

  it('formats integers with locale grouping, no decimals', () => {
    assert.equal(formatCount(1234567), '1,234,567');
    assert.equal(formatCount(0), '0');
    assert.equal(formatCount(42), '42');
  });

  it('accepts numeric strings', () => {
    assert.equal(formatCount('1000'), '1,000');
  });
});
