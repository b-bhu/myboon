import { getMeteoraLegacyMintStrategyAllocation, type MeteoraStrategy, type MeteoraStrategyBinAllocation } from '@myboon/shared/meteora';
import { decimalToAtomic, isPositiveDecimal } from './meteora.form';

/** Fixture previews may legitimately have an unused zero side. */
export function fixtureDecimalToAtomic(value: string, decimals: number): string {
  return isPositiveDecimal(value) ? decimalToAtomic(value, decimals) : '0';
}

export function getFixtureSdkStrategyAllocation(input: {
  activeBinId: number;
  binStep: number;
  minBinId: number;
  maxBinId: number;
  amountXAtomic: string;
  amountYAtomic: string;
  strategy: MeteoraStrategy;
}): MeteoraStrategyBinAllocation[] {
  return getMeteoraLegacyMintStrategyAllocation(input);
}
