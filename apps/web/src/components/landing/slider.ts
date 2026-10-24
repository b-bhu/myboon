/** Slide-to-confirm state. Pure, so it can be unit-tested without a DOM. */
export type SliderState = { phase: 'idle' | 'dragging' | 'done'; p: number }

export type SliderEvent =
  | { type: 'drag'; p: number }
  | { type: 'release' }
  | { type: 'key'; key: string }
  | { type: 'reset' }

/** Share of the track the knob must pass for a drag to confirm. */
export const CONFIRM_AT = 0.85
/** How long the confirmed state shows before the slider resets (ms). */
export const RESET_MS = 1800
export const CONFIRM_KEYS = ['Enter', ' ', 'ArrowRight'] as const

export const initialSlider: SliderState = { phase: 'idle', p: 0 }

const clamp = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0)

export function sliderReducer(s: SliderState, e: SliderEvent): SliderState {
  if (e.type === 'reset') return initialSlider
  if (s.phase === 'done') return s
  switch (e.type) {
    case 'drag':
      return { phase: 'dragging', p: clamp(e.p) }
    case 'release':
      return s.p > CONFIRM_AT ? { phase: 'done', p: 1 } : initialSlider
    case 'key':
      return (CONFIRM_KEYS as readonly string[]).includes(e.key) ? { phase: 'done', p: 1 } : s
  }
}
