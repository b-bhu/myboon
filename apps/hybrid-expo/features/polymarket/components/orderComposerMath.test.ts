import assert from 'node:assert/strict';
import { buildComposerReview, clampLimitPrice, limitPriceToDollars } from './orderComposerMath';

// --- buildComposerReview: happy path (57¢ execution, $20 spend) ---

const review = buildComposerReview({ amount: 20, executionPrice: 0.57 });
assert.equal(review.youPay, 20);
assert.equal(review.averagePriceCents, 57);
assert.ok(Math.abs((review.shares ?? 0) - 35.0877) < 0.001);
assert.equal(review.payoutIfRight, review.shares);
assert.equal(review.maximumLoss, 20);

// Payout always exceeds spend when price < $1
assert.ok((review.payoutIfRight ?? 0) > review.maximumLoss);

// --- rounding: 57.4¢ rounds to 57, 99.6¢ clamps via cents math ---

assert.equal(buildComposerReview({ amount: 10, executionPrice: 0.574 }).averagePriceCents, 57);

// --- invalid inputs degrade per-field, never throw ---

const zeroAmount = buildComposerReview({ amount: 0, executionPrice: 0.5 });
assert.equal(zeroAmount.youPay, null);
assert.equal(zeroAmount.shares, null);
assert.equal(zeroAmount.averagePriceCents, 50);
assert.equal(zeroAmount.maximumLoss, null);

const noPrice = buildComposerReview({ amount: 15, executionPrice: null });
assert.equal(noPrice.youPay, 15);
assert.equal(noPrice.shares, null);
assert.equal(noPrice.maximumLoss, 15);

const badPrice = buildComposerReview({ amount: 15, executionPrice: 1.2 });
assert.equal(badPrice.shares, null);

const nan = buildComposerReview({ amount: NaN, executionPrice: NaN });
assert.equal(nan.youPay, null);
assert.equal(nan.shares, null);

// --- extreme prices: payout sanity at 1¢ and 99¢ ---

assert.equal(buildComposerReview({ amount: 10, executionPrice: 0.01 }).payoutIfRight, 1000);
assert.ok(buildComposerReview({ amount: 10, executionPrice: 0.99 }).payoutIfRight! > 10);

// --- clampLimitPrice / limitPriceToDollars ---

assert.equal(clampLimitPrice(57), 57);
assert.equal(clampLimitPrice(0), 1);
assert.equal(clampLimitPrice(120), 99);
assert.equal(clampLimitPrice(NaN), 50);
assert.equal(clampLimitPrice(57.4), 57);
assert.equal(limitPriceToDollars(57), 0.57);
assert.equal(limitPriceToDollars(-3), 0.01);

console.log('orderComposerMath.test: all assertions passed');
