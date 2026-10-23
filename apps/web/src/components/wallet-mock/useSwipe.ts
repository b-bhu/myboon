import { useRef, type PointerEvent } from 'react'

// Same pointer pattern as the reference Swap: drag the thumb right; past 86% confirms.
export function useSwipe(onConfirm: () => void, enabled: boolean) {
  const p = useRef<{ id: number; x: number; max: number; travel: number } | null>(null)
  const set = (el: HTMLElement, t: number, max: number) => { el.style.setProperty('--travel', t + 'px'); el.style.setProperty('--progress', String(max ? t / max : 0)) }
  const end = (e: PointerEvent<HTMLButtonElement>, cancel = false) => {
    const s = p.current
    if (!s || s.id !== e.pointerId) return
    const ok = !cancel && s.travel >= s.max * 0.86
    p.current = null
    e.currentTarget.classList.remove('dragging')
    set(e.currentTarget, 0, 0)
    if (ok) onConfirm()
  }
  return {
    onPointerDown(e: PointerEvent<HTMLButtonElement>) {
      if (!enabled || e.button !== 0) return
      const r = e.currentTarget.getBoundingClientRect()
      if (e.clientX > r.left + 58) return
      p.current = { id: e.pointerId, x: e.clientX, max: r.width - 52, travel: 0 }
      e.currentTarget.setPointerCapture(e.pointerId)
      e.currentTarget.classList.add('dragging')
    },
    onPointerMove(e: PointerEvent<HTMLButtonElement>) {
      const s = p.current
      if (!s || s.id !== e.pointerId) return
      s.travel = Math.max(0, Math.min(s.max, e.clientX - s.x))
      set(e.currentTarget, s.travel, s.max)
    },
    onPointerUp: (e: PointerEvent<HTMLButtonElement>) => end(e),
    onPointerCancel: (e: PointerEvent<HTMLButtonElement>) => end(e, true),
  }
}
