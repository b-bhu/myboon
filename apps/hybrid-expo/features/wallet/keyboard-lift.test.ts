import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { walletKeyboardLiftPx } from './keyboard-lift';

const dir = dirname(fileURLToPath(import.meta.url));

/** Shared non-binding inputs for the phone-shape table (#805). */
const amountTopY = 200;
const safeTopY = 47;

function liftAt(screenHeight: number, keyboardHeight: number, sliderBottomY: number): number {
  return walletKeyboardLiftPx({
    keyboardTopY: screenHeight - keyboardHeight,
    sliderBottomY,
    amountTopY,
    safeTopY,
  });
}

test('mock frame: a 288 keyboard under the slider needs no lift', () => {
  assert.equal(liftAt(844, 288, 528), 0);
});

test('the mock limit: a 316 keyboard still clears the slider', () => {
  assert.equal(liftAt(844, 316, 528), 0);
});

test('a 340 keyboard on the mock screen lifts by its overlap', () => {
  assert.equal(liftAt(844, 340, 528), 24);
});

test('a small phone with a 291 keyboard lifts the full overlap', () => {
  assert.equal(liftAt(667, 291, 528), 152);
});

test('a large phone with a 345 keyboard clears the slider', () => {
  assert.equal(liftAt(932, 345, 528), 0);
});

test('a hidden keyboard (height 0) never lifts', () => {
  assert.equal(liftAt(844, 0, 528), 0);
  assert.equal(liftAt(667, 0, 528), 0);
});

test('the lift stops so the amount field stays below the top safe area', () => {
  const overlap = 400;
  const headroom = 100;
  const lift = walletKeyboardLiftPx({
    keyboardTopY: 528 - overlap,
    sliderBottomY: 528,
    amountTopY: safeTopY + headroom,
    safeTopY,
  });
  assert.equal(lift, headroom);
});

test('zero headroom (amount at the safe area) gives no lift', () => {
  const lift = walletKeyboardLiftPx({
    keyboardTopY: 504,
    sliderBottomY: 528,
    amountTopY: safeTopY,
    safeTopY,
  });
  assert.equal(lift, 0);
});

test('NaN or negative inputs never produce a negative or NaN lift', () => {
  const nan = Number.NaN;
  // Every slot is poisoned one value at a time.
  const base = { keyboardTopY: 504, sliderBottomY: 528, amountTopY: 200, safeTopY: 47 };
  for (const key of Object.keys(base) as (keyof typeof base)[]) {
    const poisoned = { ...base, [key]: nan }; 
    assert.equal(walletKeyboardLiftPx(poisoned), 0, key);
  }
  for (const key of Object.keys(base) as (keyof typeof base)[]) {
    const negative = { ...base, [key]: -1 };
    assert.equal(walletKeyboardLiftPx(negative), 0, key);
  }
  // No overlap at all.
  assert.equal(walletKeyboardLiftPx(base), 24);
});

test('zero measurements (nothing measured yet) give no lift', () => {
  const lift = walletKeyboardLiftPx({
    keyboardTopY: 504,
    sliderBottomY: 0,
    amountTopY: 0,
    safeTopY,
  });
  assert.equal(lift, 0);
});

/**
 * No hardcoded geometry: the lift follows the phone, so neither the pure rule
 * nor the hook may carry screen, slider or keyboard constants as code numbers.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
}

test('no three-digit literal outside comments in the lift source', () => {
  for (const name of ['keyboard-lift.ts', 'useWalletKeyboardLift.ts']) {
    const code = stripComments(readFileSync(join(dir, name), 'utf8'));
    const literal = /\b\d{3,}\b/.exec(code);
    assert.equal(literal, null, `${name} carries the number ${literal?.[0] ?? ''}`);
  }
});
