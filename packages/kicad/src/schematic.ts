// Hierarchical schematic reader: walks the .kicad_sch files from the root sheet and
// returns one record per sheet INSTANCE (a file used twice is two sheets), with the
// page number, parent, title block, the boxes of its symbols (for cross-probing) and
// of its child sheet symbols (click to open). Pure parse; no KiCad needed.
//
// Paths are instance paths without the root uuid, the same form the netlist's
// sheet `tstamps` and a footprint's `(path)` use: "/" for the root, "/<uuid>/" for a
// sub-sheet, "/<uuid>/<uuid>/" deeper.
//
// Sheet file names are resolved relative to the file that references them (KiCad's
// loader does the same), then relative to the root's directory.
//
// Symbol boxes: library graphics (rectangle, circle, arc, polyline, bezier, pins) of
// the units / body style placed, mapped by the symbol's transform exactly as KiCad
// does (lib Y up; orientation then mirror; see TRANSFORM in eeschema), in sheet mm.

import { readFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'

import { child, children, head, isList, num, parseSExpr, readTitleBlock, type SExpr } from './board-file.ts'
import type { Rect, SchematicSheet } from './types.ts'

/** A sheet as read from the files; `file` is the absolute .kicad_sch path (not the SVG). */
export interface SheetNode extends Omit<SchematicSheet, 'file'> {
  /** Absolute path of the sheet's .kicad_sch. */
  schFile: string
  /** Sheet names from the root down (root excluded), e.g. ["LED driver", "Inner"]. */
  names: string[]
}

const r4 = (v: number) => Math.round(v * 1e4) / 1e4
const s = (e: SExpr[] | undefined, i = 1): string => {
  const v = e?.[i]
  return typeof v === 'string' ? v : ''
}
const prop = (e: SExpr[], ...names: string[]): string => {
  for (const p of children(e, 'property')) if (names.includes(s(p, 1))) return s(p, 2)
  return ''
}

// ---- transforms ---------------------------------------------------------------------

interface T { x1: number; y1: number; x2: number; y2: number }
const NORMAL: T = { x1: 1, y1: 0, x2: 0, y2: -1 }
const compose = (m: T, t: T): T => ({
  x1: m.x1 * t.x1 + m.x2 * t.y1,
  y1: m.y1 * t.x1 + m.y2 * t.y1,
  x2: m.x1 * t.x2 + m.x2 * t.y2,
  y2: m.y1 * t.x2 + m.y2 * t.y2,
})
const CCW: T = { x1: 0, y1: 1, x2: -1, y2: 0 }
const MIRROR_X: T = { x1: 1, y1: 0, x2: 0, y2: -1 }
const MIRROR_Y: T = { x1: -1, y1: 0, x2: 0, y2: 1 }

/** KiCad's symbol TRANSFORM for `(at x y angle)` and `(mirror x|y)`: lib point -> offset on the sheet. */
export function symbolTransform(angle: number, mirror: string): T {
  let t = NORMAL
  const quarter = ((Math.round(angle / 90) % 4) + 4) % 4
  for (let i = 0; i < quarter; i++) t = compose(t, CCW)
  if (mirror === 'x') t = compose(t, MIRROR_X)
  if (mirror === 'y') t = compose(t, MIRROR_Y)
  return t
}

// ---- library symbol geometry ----------------------------------------------------------

type Pt = [number, number]

function libPoints(item: SExpr[]): Pt[] {
  const xy = (n: string): Pt | null => {
    const e = child(item, n)
    const x = num(e?.[1]), y = num(e?.[2])
    return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null
  }
  switch (head(item)) {
    case 'rectangle': return [xy('start'), xy('end')].filter((p): p is Pt => !!p)
    case 'circle': {
      const c = xy('center'), r = num(child(item, 'radius')?.[1])
      return c && Number.isFinite(r) ? [[c[0] - r, c[1] - r], [c[0] + r, c[1] + r]] : []
    }
    case 'arc': return [xy('start'), xy('mid'), xy('end')].filter((p): p is Pt => !!p)
    case 'polyline': case 'bezier': {
      const pts = child(item, 'pts')
      return (pts ? children(pts, 'xy') : []).map(q => [num(q[1]), num(q[2])] as Pt).filter(p => p.every(Number.isFinite))
    }
    case 'pin': {
      const at = child(item, 'at')
      const x = num(at?.[1]), y = num(at?.[2]), a = (num(at?.[3]) || 0) * Math.PI / 180
      const len = num(child(item, 'length')?.[1]) || 0
      if (!Number.isFinite(x) || !Number.isFinite(y)) return []
      return [[x, y], [x + len * Math.cos(a), y + len * Math.sin(a)]]
    }
    default: return []
  }
}

/** Lib-space points of the given unit / body style of a library symbol. */
function unitPoints(lib: SExpr[], unit: number, bodyStyle: number): Pt[] {
  const pts: Pt[] = []
  for (const sub of children(lib, 'symbol')) {
    const m = /_(\d+)_(\d+)$/.exec(s(sub, 1))
    const u = m ? Number(m[1]) : 0, st = m ? Number(m[2]) : 0
    if ((u !== 0 && u !== unit) || (st !== 0 && st !== bodyStyle)) continue
    for (const g of sub) if (isList(g)) pts.push(...libPoints(g))
  }
  for (const g of lib) if (isList(g) && head(g) !== 'symbol') pts.push(...libPoints(g))
  return pts
}

function boxOf(pts: Pt[]): Rect | null {
  if (!pts.length) return null
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1])
  const x0 = Math.min(...xs), y0 = Math.min(...ys)
  return { x: r4(x0), y: r4(y0), width: r4(Math.max(...xs) - x0), height: r4(Math.max(...ys) - y0) }
}

// ---- instances ---------------------------------------------------------------------------

/** `(instances (project "" (path "/root/..." (reference "R1") (page "2"))))` entries: path -> node. */
function instancePaths(e: SExpr[]): Map<string, SExpr[]> {
  const m = new Map<string, SExpr[]>()
  for (const inst of children(e, 'instances'))
    for (const proj of children(inst, 'project'))
      for (const p of children(proj, 'path')) m.set(s(p, 1).replace(/\/$/, ''), p)
  return m
}

/** The sheet file names a schematic references (raw, as written). */
export function sheetFileRefs(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/\(property\s+"(?:Sheetfile|Sheet file)"\s+"((?:[^"\\]|\\.)*)"/g)) out.push(m[1]!.replace(/\\(.)/g, '$1'))
  return out
}

/**
 * Every .kicad_sch reachable from the root, relative to the root's directory with
 * posix separators (sub-directories included). Files outside that directory are
 * reported through `outside` and left out.
 */
export async function schematicFileSet(rootSch: string, read: (p: string) => Promise<string> = p => readFile(p, 'utf8'),
                                       outside?: (path: string) => void): Promise<Map<string, string>> {
  const base = dirname(rootSch)
  const out = new Map<string, string>()
  const visit = async (file: string): Promise<void> => {
    const rel = relative(base, file).split(sep).join('/')
    if (out.has(rel)) return
    if (rel.startsWith('../')) { outside?.(file); return }
    let text: string
    try { text = await read(file) } catch { return }
    out.set(rel, text)
    for (const ref of sheetFileRefs(text)) {
      const a = resolve(dirname(file), ref), b = resolve(base, ref)
      let target = a
      try { await read(a) } catch { target = b }
      await visit(target)
    }
  }
  await visit(resolve(rootSch))
  return out
}

/** Read the sheet hierarchy from the root .kicad_sch. Sheets come in page order (root first). */
export async function readSchematicTree(rootSch: string, read: (p: string) => Promise<string> = p => readFile(p, 'utf8')): Promise<SheetNode[]> {
  const base = dirname(rootSch)
  const cache = new Map<string, SExpr[]>()
  const load = async (file: string): Promise<SExpr[] | null> => {
    if (cache.has(file)) return cache.get(file)!
    let text: string
    try { text = await read(file) } catch { return null }
    const root = parseSExpr(text).find(e => head(e) === 'kicad_sch')
    if (!isList(root)) return null
    cache.set(file, root)
    return root
  }
  const exists = async (f: string) => (await load(f)) !== null

  const rootDoc = await load(resolve(rootSch))
  if (!rootDoc) throw new Error(`cannot read ${rootSch}`)
  const rootUuid = s(child(rootDoc, 'uuid'))
  // KiCad 6: hierarchy pages and symbol references live in the root file
  const legacyPages = new Map<string, string>()
  for (const p of children(child(rootDoc, 'sheet_instances') ?? [], 'path')) legacyPages.set(s(p, 1), s(child(p, 'page')))
  const legacyRefs = new Map<string, SExpr[]>()
  for (const p of children(child(rootDoc, 'symbol_instances') ?? [], 'path')) legacyRefs.set(s(p, 1), p)

  const sheets: SheetNode[] = []
  const stem = (f: string) => f.split(/[\\/]/).pop()!.replace(/\.kicad_sch$/, '')

  const walk = async (file: string, doc: SExpr[], path: string, name: string, names: string[], parent: string | null, page: string,
                      symbolBox: Rect | null, depth: number): Promise<void> => {
    const full = `/${rootUuid}${path === '/' ? '' : path.replace(/\/$/, '')}`
    const libs = new Map<string, SExpr[]>()
    for (const l of children(child(doc, 'lib_symbols') ?? [], 'symbol')) libs.set(s(l, 1), l)

    const symbols: SheetNode['symbols'] = []
    for (const sym of children(doc, 'symbol')) {
      const uuid = s(child(sym, 'uuid'))
      const inst = instancePaths(sym).get(full)
      const legacy = legacyRefs.get(`${path === '/' ? '' : path.replace(/\/$/, '')}/${uuid}`)
      const ref = s(child(inst ?? legacy ?? [], 'reference')) || prop(sym, 'Reference')
      if (!ref || ref.startsWith('#')) continue
      const unit = num(child(inst ?? [], 'unit')?.[1]) || num(child(sym, 'unit')?.[1]) || 1
      const bodyStyle = num(child(sym, 'body_style')?.[1]) || num(child(sym, 'convert')?.[1]) || 1
      const lib = libs.get(s(child(sym, 'lib_name')) || s(child(sym, 'lib_id')))
      const at = child(sym, 'at')
      const ax = num(at?.[1]) || 0, ay = num(at?.[2]) || 0
      const t = symbolTransform(num(at?.[3]) || 0, s(child(sym, 'mirror')))
      const pts = (lib ? unitPoints(lib, unit, bodyStyle) : [])
        .map(([x, y]): Pt => [ax + t.x1 * x + t.y1 * y, ay + t.x2 * x + t.y2 * y])
      const bbox = boxOf(pts) ?? { x: r4(ax - 1.27), y: r4(ay - 1.27), width: 2.54, height: 2.54 }
      symbols.push({ ref, bbox })
    }

    const node: SheetNode = {
      path, name, source: relative(base, file).split(sep).join('/'), page, parent, titleBlock: readTitleBlock(doc),
      symbols, schFile: file, names, symbolBox,
    }
    sheets.push(node)
    if (depth > 32) return   // recursive hierarchy guard

    for (const sh of children(doc, 'sheet')) {
      const uuid = s(child(sh, 'uuid'))
      const childName = prop(sh, 'Sheetname', 'Sheet name') || uuid
      const ref = prop(sh, 'Sheetfile', 'Sheet file')
      if (!ref || !uuid) continue
      const a = resolve(dirname(file), ref), b = resolve(base, ref)
      const target = (await exists(a)) ? a : b
      const childDoc = await load(target)
      const childPath = `${path}${uuid}/`
      const at = child(sh, 'at'), size = child(sh, 'size')
      const box: Rect | null = at && size
        ? { x: r4(num(at[1])), y: r4(num(at[2])), width: r4(num(size[1])), height: r4(num(size[2])) } : null
      const childPage = s(child(instancePaths(sh).get(full) ?? [], 'page')) || legacyPages.get(childPath) || ''
      if (!childDoc) continue
      await walk(target, childDoc, childPath, childName, [...names, childName], path, childPage, box, depth + 1)
    }
  }

  const rootPage = legacyPages.get('/') || '1'
  await walk(resolve(rootSch), rootDoc, '/', stem(rootSch), [], null, rootPage, null, 0)

  // page order; sheets without a page number keep their walk order at the end
  const order = new Map(sheets.map((sh, i) => [sh.path, i]))
  const pageNum = (p: string) => { const n = Number(p); return p && Number.isFinite(n) ? n : Infinity }
  sheets.sort((a, b) => (a.parent === null ? -1 : b.parent === null ? 1 : 0) || pageNum(a.page) - pageNum(b.page) || order.get(a.path)! - order.get(b.path)!)
  sheets.forEach((sh, i) => { if (!sh.page) sh.page = String(i + 1) })
  return sheets
}

/** The SVG file name kicad-cli `sch export svg` gives a sheet: "<root>-<name>-<name>.svg". */
export function schematicSvgName(rootStem: string, names: string[]): string {
  return [rootStem, ...names.map(n => n.replace(/[/\\:*?"<>|]/g, '_'))].join('-') + '.svg'
}
