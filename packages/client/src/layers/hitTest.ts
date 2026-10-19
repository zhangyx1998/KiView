// [P2-d] Hit tests on the copper geometry (GeometryData) for net highlight and the
// measure tool's snapping. Board mm, y down; pad rotation is KiCad's (degrees,
// counter-clockwise as seen from the front). Pure functions.

import type { GeometryData } from '../types'

export interface Hit {
  kind: 'pad' | 'via' | 'track' | 'zone'
  net: number
  layer: string | null
  /** e.g. "R1 pad 2", "via", "track 0.25 mm" */
  label: string
}

type Pad = GeometryData['pads'][number]

/** Point in the pad's own frame (unrotated, centred). */
function padLocal(p: Pad, x: number, y: number): [number, number] {
  const dx = x - p.at.x, dy = y - p.at.y
  const a = (p.rotation * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a)
  return [c * dx - s * dy, s * dx + c * dy]
}

export function insidePad(p: Pad, x: number, y: number, tol = 0): boolean {
  const [lx, ly] = padLocal(p, x, y)
  const hw = p.size.width / 2, hh = p.size.height / 2
  if (p.shape === 'circle') return Math.hypot(lx, ly) <= hw + tol
  if (p.shape === 'oval') {
    const r = Math.min(hw, hh)
    const ex = Math.max(0, Math.abs(lx) - (hw - r)), ey = Math.max(0, Math.abs(ly) - (hh - r))
    return Math.hypot(ex, ey) <= r + tol
  }
  return Math.abs(lx) <= hw + tol && Math.abs(ly) <= hh + tol
}

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const vx = bx - ax, vy = by - ay
  const L = vx * vx + vy * vy
  const t = L ? Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / L)) : 0
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy))
}

function inPolygon(pts: number[], x: number, y: number): boolean {
  let inside = false
  for (let i = 0, j = pts.length - 2; i < pts.length; j = i, i += 2) {
    const xi = pts[i]!, yi = pts[i + 1]!, xj = pts[j]!, yj = pts[j + 1]!
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/**
 * The copper item under (x, y): pads, then vias, tracks and zone outlines, on the
 * given copper layers (nearest to the viewer first). `tol` in mm (a few pixels).
 */
export function hitTest(g: GeometryData, x: number, y: number, layers: string[], tol: number): Hit | null {
  const order = new Map(layers.map((l, i) => [l, i]))
  const rank = (ls: string[]) => Math.min(...ls.map(l => order.get(l) ?? Infinity))
  let best: { hit: Hit; rank: number; prio: number } | null = null
  const offer = (hit: Hit, r: number, prio: number) => {
    if (r === Infinity) return
    if (!best || r < best.rank || (r === best.rank && prio < best.prio)) best = { hit, rank: r, prio }
  }
  for (const p of g.pads) {
    if (!insidePad(p, x, y, tol)) continue
    offer({ kind: 'pad', net: p.net, layer: p.layers[0] ?? null, label: `${p.ref || '?'} pad ${p.number || '(no number)'}` }, rank(p.layers), 0)
  }
  for (const v of g.vias) {
    if (Math.hypot(x - v.at.x, y - v.at.y) > v.size / 2 + tol) continue
    offer({ kind: 'via', net: v.net, layer: null, label: `via ${v.size}/${v.drill} mm` }, rank(v.layers), 1)
  }
  for (const t of g.tracks) {
    const r = order.get(t.layer)
    if (r === undefined) continue
    const pts = t.pts
    for (let i = 0; i + 3 < pts.length; i += 2) {
      if (segDist(x, y, pts[i]!, pts[i + 1]!, pts[i + 2]!, pts[i + 3]!) <= t.width / 2 + tol) {
        offer({ kind: 'track', net: t.net, layer: t.layer, label: `track ${t.width} mm on ${t.layer}` }, r, 2)
        break
      }
    }
  }
  if (!best) for (const z of g.zones) {
    const r = order.get(z.layer)
    if (r !== undefined && inPolygon(z.pts, x, y)) offer({ kind: 'zone', net: z.net, layer: z.layer, label: `zone on ${z.layer}` }, r, 3)
  }
  return (best as { hit: Hit } | null)?.hit ?? null
}

/** Nearest pad or via centre within `radius` mm, for snapping. */
export function snapPoint(g: GeometryData | null, x: number, y: number, radius: number): { x: number; y: number; label: string } | null {
  if (!g) return null
  let best: { x: number; y: number; label: string; d: number } | null = null
  for (const p of g.pads) {
    const d = Math.hypot(x - p.at.x, y - p.at.y)
    if ((d <= radius || insidePad(p, x, y)) && (!best || d < best.d)) best = { x: p.at.x, y: p.at.y, label: `${p.ref} pad ${p.number}`, d }
  }
  for (const v of g.vias) {
    const d = Math.hypot(x - v.at.x, y - v.at.y)
    if (d <= Math.max(radius, v.size / 2) && (!best || d < best.d)) best = { x: v.at.x, y: v.at.y, label: 'via', d }
  }
  return best && { x: best.x, y: best.y, label: best.label }
}
