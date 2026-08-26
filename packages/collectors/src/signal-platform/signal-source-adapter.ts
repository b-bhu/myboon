import type { Signal } from './contracts'
import { validateSignal } from './validation'

export interface SignalSourceAdapter<Raw, Output extends Signal = Signal> {
  readonly sourceType: Output['sourceType']
  readonly contentKind: Output['contentKind']
  normalize(raw: Raw): Output
}

/** Runtime guard shared by future Calendar/X adapters and legacy wrappers. */
export function normalizeWithSignalAdapter<Raw, Output extends Signal>(
  adapter: SignalSourceAdapter<Raw, Output>,
  raw: Raw,
): Output {
  const signal = validateSignal(adapter.normalize(raw)) as Output
  if (signal.sourceType !== adapter.sourceType || signal.contentKind !== adapter.contentKind) {
    throw new Error(
      `Signal adapter declared ${adapter.sourceType}/${adapter.contentKind} but emitted ${signal.sourceType}/${signal.contentKind}`,
    )
  }
  return signal
}
