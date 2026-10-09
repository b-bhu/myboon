import { TokenHeatmap } from './token-heatmap';

// Preserve the overview entry point while replacing the single-token stats card.
export function TokenStats({ active = true, refreshVersion = 0 }: { active?: boolean; refreshVersion?: number }) {
  return <TokenHeatmap active={active} refreshVersion={refreshVersion} />;
}
