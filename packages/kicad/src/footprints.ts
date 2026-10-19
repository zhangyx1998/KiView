// Placed footprints of a .kicad_pcb, for cross-probing (BOM <-> 2D <-> 3D <-> schematic)
// and, later, net highlight: refdes, value, position, side, an axis-aligned box and the
// pads with their nets. Pure parse of the board file (KiCad 5 `module` .. KiCad 10).
//
// Geometry: footprint-local coordinates (also for back-side parts, whose local
// coordinates the file already stores flipped) map to the board as
//   x = fx + lx*cos(r) + ly*sin(r),  y = fy - lx*sin(r) + ly*cos(r)
// with (fx, fy, r) the footprint's `(at)` (degrees, counter-clockwise on screen).

import { child, children, head, isList, num, shapePoints, type Pt, type SExpr } from './board-file.ts'
import type { Footprint, LayerEntry, Pad, Rect } from './types.ts'

const r4 = (v: number) => Math.round(v * 1e4) / 1e4
const strAt = (e: SExpr[] | undefined, i = 1): string => {
  const v = e?.[i]
  return typeof v === 'string' ? v : ''
}

type Xf = (p: Pt) => Pt

function transform(fx: number, fy: number, deg: number): Xf {
  const a = (deg * Math.PI) / 180
  const cos = Math.cos(a), sin = Math.sin(a)
  return ([x, y]) => [fx + x * cos + y * sin, fy - x * sin + y * cos]
}

function boxOf(pts: Pt[]): Rect | null {
  if (!pts.length) return null
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const [x, y] of pts) {
    if (x < x0) x0 = x
    if (y < y0) y0 = y
    if (x > x1) x1 = x
    if (y > y1) y1 = y
  }
  return { x: r4(x0), y: r4(y0), width: r4(x1 - x0), height: r4(y1 - y0) }
}

/** Expand KiCad layer wildcards ("*.Cu", "F&B.Cu", "*.Mask") against the board's layer table. */
export function expandLayers(names: string[], table: LayerEntry[]): string[] {
  const out: string[] = []
  const all = table.map(l => l.name)
  for (const n of names) {
    if (n.startsWith('*.')) {
      const suffix = n.slice(1)
      const hits = all.filter(l => l.endsWith(suffix))
      out.push(...(hits.length ? hits : [`F${suffix}`, `B${suffix}`]))
    } else if (n.startsWith('F&B.')) {
      out.push(`F.${n.slice(4)}`, `B.${n.slice(4)}`)
    } else out.push(n)
  }
  return [...new Set(out)]
}

const PAD_TYPES = new Set(['smd', 'thru_hole', 'np_thru_hole', 'connect'])
const PAD_SHAPES = new Set(['circle', 'rect', 'oval', 'trapezoid', 'roundrect', 'chamfered_rect', 'custom'])

/** Board-level net table (KiCad <= 9 has `(net <code> "<name>")` entries at the top). */
function netTable(root: SExpr[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const n of children(root, 'net')) {
    const code = num(n[1]), name = strAt(n, 2)
    if (Number.isFinite(code) && name) m.set(name, code)
  }
  return m
}

function readPad(p: SExpr[], xf: Xf, fpRot: number, table: LayerEntry[], codeOf: (name: string, code: number) => number): Pad {
  const type = strAt(p, 2)
  const shape = strAt(p, 3)
  const at = child(p, 'at')
  const lx = num(at?.[1]) || 0, ly = num(at?.[2]) || 0
  const rot = Number.isFinite(num(at?.[3])) ? num(at?.[3]) : fpRot
  const [x, y] = xf([lx, ly])
  const size = child(p, 'size')
  const w = num(size?.[1]) || 0, h = num(size?.[2]) || w
  const drillE = child(p, 'drill')
  let drill: Pad['drill'] = null
  if (drillE) {
    const vals = drillE.slice(1).filter((v): v is string => typeof v === 'string' && v !== 'oval').map(Number)
    const dw = vals[0], dh = vals[1] ?? vals[0]
    if (dw !== undefined && Number.isFinite(dw) && dw > 0) drill = { width: dw, height: dh !== undefined && Number.isFinite(dh) ? dh : dw }
  }
  const layersE = child(p, 'layers')
  const layers = expandLayers((layersE?.slice(1) ?? []).filter((v): v is string => typeof v === 'string'), table)
  const netE = child(p, 'net')
  let net: Pad['net'] = null
  if (netE) {
    // KiCad <= 9: (net 3 "GND"); KiCad 10: (net "GND")
    const n1 = num(netE[1])
    const name = Number.isFinite(n1) && netE.length > 2 ? strAt(netE, 2) : strAt(netE, 1)
    if (name) net = { code: codeOf(name, Number.isFinite(n1) && netE.length > 2 ? n1 : NaN), name }
  }
  const pad: Pad = {
    number: strAt(p, 1),
    type: (PAD_TYPES.has(type) ? type : 'smd') as Pad['type'],
    shape: (PAD_SHAPES.has(shape) ? shape : 'custom') as Pad['shape'],
    at: { x: r4(x), y: r4(y) },
    rotation: r4(((rot % 360) + 360) % 360),
    size: { width: r4(w), height: r4(h) },
    drill,
    layers,
    net,
  }
  const pf = strAt(child(p, 'pinfunction')), pt = strAt(child(p, 'pintype'))
  if (pf) pad.pinFunction = pf
  if (pt) pad.pinType = pt
  return pad
}

/** Corners of a pad's (rotated) size rectangle in board coordinates. */
function padCorners(pad: Pad): Pt[] {
  const a = (pad.rotation * Math.PI) / 180
  const cos = Math.cos(a), sin = Math.sin(a)
  const hw = pad.size.width / 2, hh = pad.size.height / 2
  return ([[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]] as Pt[])
    .map(([x, y]) => [pad.at.x + x * cos + y * sin, pad.at.y - x * sin + y * cos])
}

/** Every placed footprint of a parsed board. */
export function readFootprints(root: SExpr[], table: LayerEntry[]): Footprint[] {
  const nets = netTable(root)
  let nextCode = Math.max(0, ...nets.values()) + 1
  const codeOf = (name: string, code: number): number => {
    if (Number.isFinite(code)) return code
    let c = nets.get(name)
    if (c === undefined) { c = nextCode++; nets.set(name, c) }
    return c
  }

  const out: Footprint[] = []
  for (const e of root) {
    if (!isList(e) || (head(e) !== 'footprint' && head(e) !== 'module')) continue
    const layer = strAt(child(e, 'layer'))
    const at = child(e, 'at')
    const fx = num(at?.[1]) || 0, fy = num(at?.[2]) || 0, rot = num(at?.[3]) || 0
    const xf = transform(fx, fy, rot)

    // properties: KiCad 8+ (property "Name" "value" ...), KiCad 5..7 (fp_text reference ...) + (property "k" "v")
    const props: Record<string, string> = {}
    for (const p of children(e, 'property')) {
      const k = strAt(p, 1)
      if (k) props[k] = strAt(p, 2)
    }
    for (const t of children(e, 'fp_text')) {
      const kind = strAt(t, 1)
      if (kind === 'reference' && !('Reference' in props)) props.Reference = strAt(t, 2)
      if (kind === 'value' && !('Value' in props)) props.Value = strAt(t, 2)
    }
    const attrs = new Set((child(e, 'attr')?.slice(1) ?? []).filter((v): v is string => typeof v === 'string'))
    const dnpE = child(e, 'dnp')
    const fields: Record<string, string> = {}
    for (const [k, v] of Object.entries(props)) if (k !== 'Reference' && k !== 'Value' && k !== 'Footprint') fields[k] = v

    const pads = children(e, 'pad').map(p => readPad(p, xf, rot, table, codeOf))

    // box: courtyard if any, else pads + fab / silk graphics
    const graphics = e.filter((c): c is SExpr[] => isList(c) && !!head(c)?.startsWith('fp_') && head(c) !== 'fp_text')
    const onLayers = (re: RegExp) => graphics.filter(g => re.test(strAt(child(g, 'layer'))))
    const crt = onLayers(/^[FB]\.(CrtYd|Courtyard)$/).flatMap(g => shapePoints(g, xf))
    let pts: Pt[] = crt
    if (!pts.length) {
      pts = [...pads.flatMap(padCorners), ...onLayers(/^[FB]\.(Fab|SilkS|Silkscreen)$/).flatMap(g => shapePoints(g, xf))]
    }
    const bbox = boxOf(pts) ?? { x: r4(fx), y: r4(fy), width: 0, height: 0 }

    out.push({
      ref: props.Reference ?? '',
      value: props.Value ?? '',
      footprint: strAt(e, 1),
      side: layer === 'B.Cu' ? 'back' : 'front',
      at: { x: r4(fx), y: r4(fy) },
      rotation: r4(rot),
      bbox,
      pads,
      fields,
      dnp: attrs.has('dnp') || (dnpE !== undefined && strAt(dnpE, 1) !== 'no'),
      excludeFromBom: attrs.has('exclude_from_bom'),
      excludeFromPos: attrs.has('exclude_from_pos_files'),
      path: strAt(child(e, 'path')) || null,
    })
  }
  return out
}
