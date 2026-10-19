// Copper geometry per net from a .kicad_pcb, for the client's net highlight and
// measure tools [P2-d]: tracks (arcs flattened), vias, pads and zone outlines.
//
// Pads come from BoardInfo.footprints when a backend filled them ([P2-b]); this file
// carries its own small pad walk as the fallback, so the tools also work with a
// backend that does not parse footprints. Units: mm, board coordinates (y down).

import { child, children, head, isList, num, type SExpr } from './board-file.ts'
import type { BoardGeometry, Footprint, GeometryPad } from './types.ts'

type Pt = [number, number]

const str = (e: SExpr | undefined): string | null => (typeof e === 'string' ? e : null)
const r4 = (v: number) => Math.round(v * 1e4) / 1e4

function xyOf(e: SExpr[] | undefined): Pt | null {
  if (!e) return null
  const x = num(e[1]), y = num(e[2])
  return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null
}

/** Copper layer names of the board, front to back. */
export function copperLayerNames(root: SExpr[]): string[] {
  const names: string[] = []
  for (const e of child(root, 'layers')?.slice(1) ?? []) if (isList(e) && typeof e[1] === 'string' && /^(F|B|In\d+)\.Cu$/.test(e[1])) names.push(e[1])
  const pos = (n: string) => (n === 'F.Cu' ? 0 : n === 'B.Cu' ? 1000 : Number(n.slice(2, -3)))
  return names.sort((a, b) => pos(a) - pos(b))
}

/** Expand KiCad layer wildcards ("*.Cu", "F&B.Cu", "*.Mask") against the copper stack. */
export function expandLayers(layers: string[], copper: string[]): string[] {
  const out = new Set<string>()
  for (const l of layers) {
    if (l === '*.Cu') copper.forEach(c => out.add(c))
    else if (l === 'F&B.Cu') { out.add('F.Cu'); out.add('B.Cu') }
    else if (l.startsWith('*.')) { out.add(`F.${l.slice(2)}`); out.add(`B.${l.slice(2)}`) }
    else out.add(l)
  }
  return [...out]
}

/** Net name of an item: `(net "name")` (KiCad 10) or `(net <code> ["name"])` with the board's net table. */
function netName(e: SExpr[], table: Map<string, string>): string | null {
  const n = child(e, 'net')
  if (!n) return null
  const a = str(n[1]), b = str(n[2])
  if (b !== null) return b || null
  if (a === null) return null
  if (/^\d+$/.test(a)) return table.get(a) || null
  return a || null
}

function netTable(root: SExpr[]): Map<string, string> {
  const t = new Map<string, string>()
  for (const n of children(root, 'net')) { const c = str(n[1]), name = str(n[2]); if (c !== null && name !== null) t.set(c, name) }
  return t
}

/** Points along an arc through start, mid, end (inclusive), for drawing and hit tests. */
export function arcPolyline(s: Pt, m: Pt, e: Pt, maxSeg = 16): Pt[] {
  const [ax, ay] = s, [bx, by] = m, [cx, cy] = e
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
  if (Math.abs(d) < 1e-12) return [s, e]
  const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy
  const ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d
  const uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d
  const r = Math.hypot(ax - ux, ay - uy)
  const a0 = Math.atan2(ay - uy, ax - ux)
  const norm = (a: number) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
  const am = norm(Math.atan2(by - uy, bx - ux) - a0), ae = norm(Math.atan2(cy - uy, cx - ux) - a0)
  const sweep = am < ae ? ae : ae - 2 * Math.PI   // through mid
  const n = Math.max(2, Math.min(maxSeg, Math.ceil(Math.abs(sweep) / (Math.PI / 16))))
  const pts: Pt[] = []
  for (let i = 0; i <= n; i++) {
    const t = a0 + (sweep * i) / n
    pts.push([ux + r * Math.cos(t), uy + r * Math.sin(t)])
  }
  return pts
}

/** One pad of a footprint as found in the file, absolute. */
export interface RawPad {
  ref: string
  number: string
  type: 'smd' | 'thru_hole' | 'np_thru_hole' | 'connect'
  shape: string
  at: Pt
  rotation: number
  size: { width: number; height: number }
  drill: { width: number; height: number } | null
  layers: string[]
  net: string | null
  fpSide: 'front' | 'back'
}

/** One footprint as found in the file (just what stats and geometry need). */
export interface RawFootprint {
  ref: string
  side: 'front' | 'back'
  /** `(attr smd)`, `(attr through_hole)`, else 'other'. */
  kind: 'smd' | 'tht' | 'other'
  pads: RawPad[]
}

/** Walk the footprints and their pads (absolute positions, nets, wildcard layers expanded). */
export function readRawFootprints(root: SExpr[]): RawFootprint[] {
  const copper = copperLayerNames(root)
  const nets = netTable(root)
  const out: RawFootprint[] = []
  for (const fp of children(root, 'footprint')) {
    const at = child(fp, 'at')
    const fx = num(at?.[1]) || 0, fy = num(at?.[2]) || 0, frot = num(at?.[3]) || 0
    const rad = (frot * Math.PI) / 180, cos = Math.cos(rad), sin = Math.sin(rad)
    const side: 'front' | 'back' = str(child(fp, 'layer')?.[1]) === 'B.Cu' ? 'back' : 'front'
    const refProp = children(fp, 'property').find(p => p[1] === 'Reference')
    const refText = children(fp, 'fp_text').find(p => p[1] === 'reference')
    const ref = str(refProp?.[2]) ?? str(refText?.[2]) ?? ''
    const attr = child(fp, 'attr')
    const kind = attr?.includes('smd') ? 'smd' : attr?.includes('through_hole') ? 'tht' : 'other'
    const pads: RawPad[] = []
    for (const p of children(fp, 'pad')) {
      const pat = child(p, 'at')
      const px = num(pat?.[1]) || 0, py = num(pat?.[2]) || 0
      const size = child(p, 'size')
      const drill = child(p, 'drill')
      let dr: RawPad['drill'] = null
      if (drill) {
        const oval = drill[1] === 'oval'
        const w = num(drill[oval ? 2 : 1]), h = num(drill[oval ? 3 : 1])
        if (Number.isFinite(w) && w > 0) dr = { width: w, height: Number.isFinite(h) && h > 0 ? h : w }
      }
      const layers = child(p, 'layers')?.slice(1).filter((v): v is string => typeof v === 'string') ?? []
      pads.push({
        ref, number: str(p[1]) ?? '',
        type: (str(p[2]) ?? 'smd') as RawPad['type'],
        shape: str(p[3]) ?? 'rect',
        at: [fx + px * cos + py * sin, fy - px * sin + py * cos],
        rotation: num(pat?.[3]) || 0,
        size: { width: num(size?.[1]) || 0, height: num(size?.[2]) || 0 },
        drill: dr,
        layers: expandLayers(layers, copper),
        net: netName(p, nets),
        fpSide: side,
      })
    }
    out.push({ ref, side, kind, pads })
  }
  return out
}

const padShape = (s: string): GeometryPad['shape'] =>
  s === 'circle' ? 'circle' : s === 'oval' ? 'oval' : s === 'roundrect' || s === 'chamfered_rect' ? 'roundrect' : 'rect'

/**
 * Copper geometry by net. `footprints`: BoardInfo.footprints when the backend parsed
 * them ([P2-b]); when empty the file's pads are read here.
 */
export function readGeometry(root: SExpr[], footprints: Footprint[] = []): BoardGeometry {
  const copper = copperLayerNames(root)
  const table = netTable(root)
  const names: string[] = ['']
  const index = new Map<string, number>([['', 0]])
  const netId = (name: string | null | undefined): number => {
    if (!name) return 0
    let i = index.get(name)
    if (i === undefined) { i = names.length; names.push(name); index.set(name, i) }
    return i
  }

  const tracks: BoardGeometry['tracks'] = []
  const vias: BoardGeometry['vias'] = []
  const zones: BoardGeometry['zones'] = []
  for (const e of root) {
    if (!isList(e)) continue
    const h = head(e)
    if (h === 'segment' || h === 'arc') {
      const layer = str(child(e, 'layer')?.[1])
      const width = num(child(e, 'width')?.[1])
      const s = xyOf(child(e, 'start')), en = xyOf(child(e, 'end'))
      if (!layer || !s || !en || !Number.isFinite(width)) continue
      const m = h === 'arc' ? xyOf(child(e, 'mid')) : null
      const pts = m ? arcPolyline(s, m, en) : [s, en]
      tracks.push({ net: netId(netName(e, table)), layer, width, pts: pts.flat().map(r4) })
    } else if (h === 'via') {
      const at = xyOf(child(e, 'at'))
      if (!at) continue
      const layers = child(e, 'layers')?.slice(1).filter((v): v is string => typeof v === 'string') ?? ['F.Cu', 'B.Cu']
      vias.push({ net: netId(netName(e, table)), at: { x: at[0], y: at[1] }, size: num(child(e, 'size')?.[1]) || 0,
                  drill: num(child(e, 'drill')?.[1]) || 0, layers: expandLayers(layers, copper) })
    } else if (h === 'zone') {
      const layers = [str(child(e, 'layer')?.[1]), ...(child(e, 'layers')?.slice(1) ?? [])].filter((v): v is string => typeof v === 'string')
      const poly = child(e, 'polygon')
      const pts = poly ? children(child(poly, 'pts') ?? [], 'xy').map(xyOf).filter((p): p is Pt => !!p) : []
      if (pts.length < 3) continue
      const net = netId(netName(e, table))
      for (const layer of expandLayers(layers, copper)) if (copper.includes(layer)) zones.push({ net, layer, pts: pts.flat().map(r4) })
    }
  }

  const pads: GeometryPad[] = []
  if (footprints.some(f => f.pads.length)) {
    for (const f of footprints) for (const p of f.pads) {
      pads.push({ net: netId(p.net?.name), ref: f.ref, number: p.number, at: { x: r4(p.at.x), y: r4(p.at.y) }, rotation: p.rotation,
                  shape: padShape(p.shape), size: p.size, drill: p.drill, layers: expandLayers(p.layers, copper).filter(l => copper.includes(l)) })
    }
  } else {
    for (const f of readRawFootprints(root)) for (const p of f.pads) {
      pads.push({ net: netId(p.net), ref: p.ref, number: p.number, at: { x: r4(p.at[0]), y: r4(p.at[1]) }, rotation: p.rotation,
                  shape: padShape(p.shape), size: p.size, drill: p.drill, layers: p.layers.filter(l => copper.includes(l)) })
    }
  }
  return { nets: names, copper, tracks, vias, pads, zones }
}
