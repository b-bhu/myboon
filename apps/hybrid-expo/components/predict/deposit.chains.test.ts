/** Source-level contract for the live, exact Bridge deposit routes. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MODAL_SOURCE = readFileSync(join(__dirname, 'DepositModal.tsx'), 'utf8');
const API_SOURCE = readFileSync(join(__dirname, '../../features/predict/predict.api.ts'), 'utf8');

describe('deposit sheet exact route allowlist', () => {
  it('offers only exact native Polygon USDC and Solana USDC', () => {
    assert.match(API_SOURCE, /POLYGON_CHAIN_ID = '137'/);
    assert.match(API_SOURCE, /POLYGON_USDC = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'/);
    assert.match(API_SOURCE, /SOLANA_CHAIN_ID = '1151111081099710'/);
    assert.match(API_SOURCE, /SOLANA_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'/);
    assert.match(API_SOURCE, /selectSupportedDepositAssets/);
  });

  it('derives rendered routes from the live supported-assets response', () => {
    assert.match(MODAL_SOURCE, /fetchBridgeSupportedAssets\(\)/);
    assert.match(MODAL_SOURCE, /setSupportedAssets\(selectSupportedDepositAssets\(assets\)\)/);
    assert.doesNotMatch(MODAL_SOURCE, /Object\.entries\(addresses\)/);
  });

  it('uses each live route minimum and blocks copy below it', () => {
    assert.match(MODAL_SOURCE, /plannedAmount < asset\.minCheckoutUsd/);
    assert.match(MODAL_SOURCE, /disabled=\{!amountValid\}/);
    assert.match(MODAL_SOURCE, /Live min \$\{asset\.minCheckoutUsd\.toFixed\(2\)\}/);
    assert.doesNotMatch(MODAL_SOURCE, /Min:\s*\$1/);
  });

  it('handles a response carrying no supported route', () => {
    assert.match(MODAL_SOURCE, /chains\.length === 0/);
  });

  it('enforces the documented sub-10bp offramp swap rule', () => {
    assert.match(API_SOURCE, /quote\.estFeeBreakdown\.swapImpact/);
    assert.match(API_SOURCE, /impact >= MAX_WITHDRAW_BRIDGE_IMPACT_PERCENT/);
    assert.doesNotMatch(API_SOURCE, /const impact = quote\.estFeeBreakdown\.totalImpact/);
  });
});
