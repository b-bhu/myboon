export type Pt = [number, number]

/** Smooth cubic path through points, easing along x or y. Straight line for near-level hops. */
export function curve(pts: Pt[], axis: 'x' | 'y'): string {
  if (!pts.length) return ''
  let d = `M${r(pts[0][0])},${r(pts[0][1])}`
  for (let i = 1; i < pts.length; i++) {
    const [px, py] = pts[i - 1]
    const [qx, qy] = pts[i]
    if (axis === 'y' && Math.abs(py - qy) < 4) {
      d += ` L${r(qx)},${r(qy)}`
    } else if (axis === 'x') {
      const mx = (px + qx) / 2
      d += ` C${r(mx)},${r(py)} ${r(mx)},${r(qy)} ${r(qx)},${r(qy)}`
    } else {
      const my = (py + qy) / 2
      d += ` C${r(px)},${r(my)} ${r(qx)},${r(my)} ${r(qx)},${r(qy)}`
    }
  }
  return d
}

const r = (n: number) => Math.round(n * 10) / 10
