export type MeteoraFixtureScenario = 'balanced' | 'zero-usdc' | 'low-native' | 'cost-error' | 'quote-error' | 'quote-delay' | 'sdk-offset' | 'sdk-move';

export interface MeteoraFixturePoolMovement {
  moved: boolean;
}

/** Deterministic dev-only SDK state; no RPC, signer, or transaction involved. */
export function getMeteoraFixturePoolSnapshot(
  scenario: MeteoraFixtureScenario,
  movement: MeteoraFixturePoolMovement,
): { activeBinId: number; currentPrice: string } {
  if (scenario === 'sdk-offset') return { activeBinId: 17, currentPrice: '77.1123456789' };
  if (scenario === 'sdk-move' && movement.moved) return { activeBinId: 1, currentPrice: '76.3608172816603' };
  return { activeBinId: 0, currentPrice: '76.33028516759326' };
}
