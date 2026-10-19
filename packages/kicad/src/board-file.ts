// Minimal reader for .kicad_pcb files: S-expression parsing, the layer table, the
// Edge.Cuts outline extent, title block, stackup and header fields. No KiCad
// dependency; every backend's boardInfo() starts from this.
//
// Footprints (ref, value, position, side, bbox, pads) for cross-probing: footprints.ts.

import type { BoardInfo, LayerEntry, Rect, Stackup, TitleBlock } from './types.ts'
import { readFootprints } from './footprints.ts'
import { minKicadFor } from './versions.ts'

export type SExpr = string | SExpr[]

/** Parse a KiCad S-expression document. Quoted and bare atoms both become strings. */
export function parseSExpr(text: string): SExpr[] {
  const root: SExpr[] = []
  const stack: SExpr[][] = [root]
  const n = text.length
  let i = 0
  while (i < n) {
    const c = text.charCodeAt(i)
    if (c === 40 /* ( */) {
      const list: SExpr[] = []
      stack[stack.length - 1]!.push(list)
      stack.push(list)
      i++
    } else if (c === 41 /* ) */) {
      if (stack.length === 1) throw new Error(`unbalanced ')' at offset ${i}`)
      stack.pop()
      i++
    } else if (c === 34 /* " */) {
      let s = ''
      i++
      while (i < n) {
        const d = text[i]!
        if (d === '\\' && i + 1 < n) { s += text[i + 1]; i += 2; continue }
        if (d === '"') break
        s += d
        i++
      }
      if (i >= n) throw new Error('unterminated string')
      stack[stack.length - 1]!.push(s)
      i++
    } else if (c <= 32) {
      i++
    } else {
      let j = i
      while (j < n) {
        const d = text.charCodeAt(j)
        if (d <= 32 || d === 40 || d === 41) break
        j++
      }
      stack[stack.length - 1]!.push(text.slice(i, j))
      i = j
    }
  }
  if (stack.length !== 1) throw new Error('unbalanced S-expression (truncated file?)')
  return root
}

export const isList = (e: SExpr | undefined): e is SExpr[] => Array.isArray(e)
export const head = (e: SExpr): string | undefined => (isList(e) && typeof e[0] === 'string' ? e[0] : undefined)
export const child = (e: SExpr[], name: string): SExpr[] | undefined =>
  e.find((c): c is SExpr[] => head(c) === name)
export const children = (e: SExpr[], name: string): SExpr[][] =>
  e.filter((c): c is SExpr[] => head(c) === name)
export const num = (e: SExpr | undefined): number => (typeof e === 'string' ? Number(e) : NaN)
function xy(e: SExpr[] | undefined): [number, number] | null {
  if (!e) return null
  const x = num(e[1]), y = num(e[2])
  return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null
}

const str = (e: SExpr[] | undefined, i = 1): string | null => {
  const v = e?.[i]
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

/** The `(version YYYYMMDD)` of a KiCad s-expression file, from its first lines (cheap). */
export function formatVersionOf(text: string): number | null {
  const m = /^\s*\(\w+\s*\(version\s+(\d+)\)/.exec(text.slice(0, 400))
  return m ? Number(m[1]) : null
}

export function readTitleBlock(root: SExpr[]): TitleBlock {
  const tb = child(root, 'title_block')
  const field = (n: string) => (tb ? str(child(tb, n)) : null)
  const comments = tb ? children(tb, 'comment').sort((a, b) => num(a[1]) - num(b[1])).map(c => str(c, 2) ?? '') : []
  return { title: field('title'), rev: field('rev'), date: field('date'), company: field('company'), comments }
}

function readStackup(root: SExpr[], layers: LayerEntry[]): Stackup {
  const setup = child(root, 'setup')
  const st = setup && child(setup, 'stackup')
  const byType = (t: string) => st && children(st, 'layer').find(l => str(child(l, 'type')) === t)
  const colour = (t: string) => { const l = byType(t); return l ? str(child(l, 'color')) : null }
  const general = child(root, 'general')
  const thickness = general ? num(child(general, 'thickness')?.[1]) : NaN
  return {
    maskColor: { front: colour('Top Solder Mask'), back: colour('Bottom Solder Mask') },
    silkColor: { front: colour('Top Silk Screen'), back: colour('Bottom Silk Screen') },
    finish: st ? str(child(st, 'copper_finish')) : null,
    thickness: Number.isFinite(thickness) ? thickness : null,
    copperLayers: layers.filter(l => /^(F|B|In\d+)\.Cu$/.test(l.name)).length,
  }
}

/** Parse a .kicad_pcb file. Throws on a truncated or invalid file. */
export function readBoard(text: string): BoardInfo {
  const doc = parseSExpr(text)
  const root = doc.find(e => head(e) === 'kicad_pcb')
  if (!isList(root)) throw new Error('not a kicad_pcb file')

  const layers: LayerEntry[] = []
  for (const e of child(root, 'layers')?.slice(1) ?? []) {
    if (!isList(e)) continue
    const [n, name, type, userName] = e
    if (typeof name !== 'string') continue
    const entry: LayerEntry = { number: num(n), name, type: typeof type === 'string' ? type : 'user' }
    if (typeof userName === 'string') entry.userName = userName
    layers.push(entry)
  }

  const usedLayers = new Set<string>()
  const walk = (e: SExpr[]): void => {
    const h = head(e)
    if (h === 'layer' || h === 'layers') {
      for (const v of e.slice(1)) if (typeof v === 'string') usedLayers.add(v)
      return
    }
    for (const c of e) if (isList(c)) walk(c)
  }
  for (const c of root) if (isList(c) && head(c) !== 'layers' && head(c) !== 'setup') walk(c)

  const formatVersion = num(child(root, 'version')?.[1])
  return {
    formatVersion: Number.isFinite(formatVersion) ? formatVersion : 0,
    minKicad: minKicadFor(Number.isFinite(formatVersion) ? formatVersion : 0, 'pcb'),
    generator: str(child(root, 'generator')),
    generatorVersion: str(child(root, 'generator_version')),
    titleBlock: readTitleBlock(root),
    layers,
    usedLayers: [...usedLayers].sort(),
    outline: outlineExtent(root),
    stackup: readStackup(root, layers),
    footprints: readFootprints(root, layers),
  }
}

// ---- Edge.Cuts extent ---------------------------------------------------

export type Pt = [number, number]
type Xf = (p: Pt) => Pt

function onEdge(e: SExpr[]): boolean {
  const l = child(e, 'layer')
  return !!l && l[1] === 'Edge.Cuts'
}

/** Points that bound an arc given by start, mid, end (exact: includes axis extremes). */
function arcPoints(s: Pt, m: Pt, e: Pt): Pt[] {
  const pts: Pt[] = [s, m, e]
  const ax = s[0], ay = s[1], bx = m[0], by = m[1], cx = e[0], cy = e[1]
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
  if (Math.abs(d) < 1e-12) return pts
  const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy
  const ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d
  const uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d
  const r = Math.hypot(ax - ux, ay - uy)
  const ang = (p: Pt) => Math.atan2(p[1] - uy, p[0] - ux)
  const norm = (a: number) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
  const a0 = ang(s), am = norm(ang(m) - a0), ae = norm(ang(e) - a0)
  const ccw = am < ae   // sweep from start to end passing through mid, in increasing angle
  for (let k = 0; k < 4; k++) {
    const t = (k * Math.PI) / 2
    const rel = norm(t - a0)
    const inside = ccw ? rel <= ae : rel >= ae || rel === 0
    if (inside) pts.push([ux + r * Math.cos(t), uy + r * Math.sin(t)])
  }
  return pts
}

/** Points bounding a gr_* / fp_* shape (line, rect, arc, circle, poly, curve), through `xf`. */
export function shapePoints(e: SExpr[], xf: Xf): Pt[] {
  const h = head(e)!
  const kind = h.slice(3) // strip gr_ / fp_
  const p = (name: string) => { const v = xy(child(e, name)); return v ? xf(v) : null }
  switch (kind) {
    case 'line': case 'rect': {
      const s = p('start'), en = p('end')
      if (!s || !en) return []
      if (kind === 'rect') {
        const a = child(e, 'start')!, b = child(e, 'end')!
        const c1 = xf([num(a[1]), num(b[2])]), c2 = xf([num(b[1]), num(a[2])])
        return [s, en, c1, c2]
      }
      return [s, en]
    }
    case 'arc': {
      const s = p('start'), m = p('mid'), en = p('end')
      return s && m && en ? arcPoints(s, m, en) : []
    }
    case 'circle': {
      const c = p('center'), en = p('end')
      if (!c || !en) return []
      const r = Math.hypot(en[0] - c[0], en[1] - c[1])
      return [[c[0] - r, c[1] - r], [c[0] + r, c[1] + r]]
    }
    case 'poly': case 'curve': {
      const pts = child(e, 'pts')
      return (pts ? children(pts, 'xy') : []).map(q => xy(q)).filter((q): q is Pt => !!q).map(xf)
    }
    default:
      return []
  }
}

function outlineExtent(root: SExpr[]): Rect | null {
  const pts: Pt[] = []
  const id: Xf = p => p
  for (const e of root) {
    if (!isList(e)) continue
    const h = head(e)
    if (h?.startsWith('gr_') && onEdge(e)) pts.push(...shapePoints(e, id))
    if (h === 'footprint') {
      const at = child(e, 'at')
      const fx = num(at?.[1]) || 0, fy = num(at?.[2]) || 0, rot = (num(at?.[3]) || 0) * Math.PI / 180
      const cos = Math.cos(rot), sin = Math.sin(rot)
      const xf: Xf = ([x, y]) => [fx + x * cos + y * sin, fy - x * sin + y * cos]
      for (const c of e) if (isList(c) && head(c)?.startsWith('fp_') && onEdge(c)) pts.push(...shapePoints(c, xf))
    }
  }
  if (!pts.length) return null
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1])
  const x0 = Math.min(...xs), y0 = Math.min(...ys)
  return { x: x0, y: y0, width: Math.max(...xs) - x0, height: Math.max(...ys) - y0 }
}

/** "LEDStrip" -> "LED Strip", "RibbonAdapter" -> "Ribbon Adapter". */
export function titleFromName(name: string): string {
  return name
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .trim()
}
