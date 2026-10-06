import type { MeteoraRangePresetDefinition } from '@myboon/shared/meteora';
import { resolveSolanaRpcUrl, resolveSolanaRpcWsUrl } from '@/lib/rpc';

export const METEORA_RPC_URL = resolveSolanaRpcUrl();
export const METEORA_RPC_WS_URL = resolveSolanaRpcWsUrl();

/**
 * Keep multi-step Zap submission gated until a process restart can reconstruct
 * only the remaining safe steps without replaying a confirmed swap.
 */
export const METEORA_ZAP_EXECUTION_ENABLED = false;

/**
 * Meteora does not currently publish Focused/Balanced/Wide bin deltas through
 * the SDK. Keep the product labels visible but unavailable until an exact
 * Meteora-sourced value is configured; myBoon must not invent widths.
 */
export const METEORA_RANGE_PRESETS: readonly MeteoraRangePresetDefinition[] = [
  { id: 'focused', label: 'Focused', source: 'meteora', binDelta: null },
  { id: 'balanced', label: 'Balanced', source: 'meteora', binDelta: null },
  { id: 'wide', label: 'Wide', source: 'meteora', binDelta: null },
];
