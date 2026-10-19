// KiCad netlist (`kicad-cli sch export netlist`, default "kicadsexpr" format) and the
// BOM built from it. The netlist is the robust source for both: it carries every
// component of every sheet instance with all its fields, the DNP and
// exclude-from-BOM flags, the symbol path (joins footprints), and the nets with
// their nodes, in one kicad-cli call and without knowing field names in advance.

import { child, children, head, isList, num, parseSExpr, type SExpr } from './board-file.ts'
import type { BomRow, Footprint, Net, Netlist } from './types.ts'

export interface NetlistComponent {
  ref: string
  value: string
  footprint: string
  /** Symbol fields (Datasheet, Description, MPN, ...), Footprint and empty values left out. */
  fields: Record<string, string>
  dnp: boolean
  excludeFromBom: boolean
  excludeFromBoard: boolean
  /** "/<sheet uuids>/<symbol uuid>", the footprint's `(path)`. */
  path: string
  /** Sheet instance path, "/" or "/<uuid>/". */
  sheet: string
}

export interface ParsedNetlist extends Netlist {
  components: NetlistComponent[]
}

const s = (e: SExpr[] | undefined, i = 1): string => {
  const v = e?.[i]
  return typeof v === 'string' ? v : ''
}

const FIELD_SKIP = new Set(['Footprint', 'Reference', 'Value'])
/** Placeholders KiCad uses for "no value". */
const blank = (v: string) => !v.trim() || v.trim() === '~'

export function parseNetlist(text: string): ParsedNetlist {
  const root = parseSExpr(text).find(e => head(e) === 'export')
  if (!isList(root)) throw new Error('not a KiCad s-expression netlist')

  const components: NetlistComponent[] = []
  for (const c of children(child(root, 'components') ?? [], 'comp')) {
    const fields: Record<string, string> = {}
    for (const f of children(child(c, 'fields') ?? [], 'field')) {
      const name = s(child(f, 'name'))
      const value = f.slice(2).filter((v): v is string => typeof v === 'string').join('')
      if (name && !FIELD_SKIP.has(name) && !blank(value)) fields[name] = value
    }
    const props = new Map(children(c, 'property').map(p => [s(child(p, 'name')), s(child(p, 'value'))] as const))
    // KiCad 6/7 netlists have no (fields) for datasheet: take the top-level entries too
    const ds = s(child(c, 'datasheet'))
    if (!('Datasheet' in fields) && !blank(ds)) fields.Datasheet = ds
    const desc = s(child(c, 'description'))
    if (!('Description' in fields) && !blank(desc)) fields.Description = desc
    const sheet = s(child(child(c, 'sheetpath') ?? [], 'tstamps')) || '/'
    const uuid = s(child(c, 'tstamps')) || s(child(c, 'tstamp'))
    components.push({
      ref: s(child(c, 'ref')),
      value: s(child(c, 'value')),
      footprint: s(child(c, 'footprint')),
      fields,
      dnp: props.has('dnp'),
      excludeFromBom: props.has('exclude_from_bom'),
      excludeFromBoard: props.has('exclude_from_board'),
      path: `${sheet.endsWith('/') ? sheet : sheet + '/'}${uuid}`,
      sheet,
    })
  }

  const nets: Net[] = []
  for (const n of children(child(root, 'nets') ?? [], 'net')) {
    const net: Net = {
      code: num(child(n, 'code')?.[1]) || 0,
      name: s(child(n, 'name')),
      nodes: children(n, 'node').map(nd => {
        const node: Net['nodes'][number] = { ref: s(child(nd, 'ref')), pin: s(child(nd, 'pin')) }
        const pf = s(child(nd, 'pinfunction')), pt = s(child(nd, 'pintype'))
        if (pf) node.pinFunction = pf
        if (pt) node.pinType = pt
        return node
      }),
    }
    const cls = s(child(n, 'class'))
    if (cls) net.netClass = cls
    nets.push(net)
  }
  return { nets, components }
}

// ---- BOM -------------------------------------------------------------------------------

/** "R2" < "R10" < "RN1"; "U1A" after "U1". */
export function compareRefs(a: string, b: string): number {
  const pa = /^(\D*)(\d*)(.*)$/.exec(a)!, pb = /^(\D*)(\d*)(.*)$/.exec(b)!
  return pa[1]!.localeCompare(pb[1]!) || (Number(pa[2] || -1) - Number(pb[2] || -1)) || pa[3]!.localeCompare(pb[3]!)
}

/** Fields that do not split a group (free text). */
const NON_GROUPING = new Set(['Description'])

/**
 * Group identical parts: same value, footprint, DNP / exclude flags and the same
 * grouping fields (every field but Description). Rows keep the first non-empty
 * Description. Rows sort by their first reference. Lossless: expanding a row's refs
 * gives back one row per part.
 */
export function groupBom(items: BomRow[]): BomRow[] {
  const groups = new Map<string, BomRow>()
  for (const it of items) {
    const keyFields = Object.entries(it.fields).filter(([k]) => !NON_GROUPING.has(k)).sort(([a], [b]) => a.localeCompare(b))
    const key = JSON.stringify([it.value, it.footprint, it.dnp, it.excludeFromBom, keyFields])
    const g = groups.get(key)
    if (!g) { groups.set(key, { ...it, refs: [...it.refs], fields: { ...it.fields } }); continue }
    g.refs.push(...it.refs)
    for (const [k, v] of Object.entries(it.fields)) if (!(k in g.fields)) g.fields[k] = v
  }
  const rows = [...groups.values()]
  for (const r of rows) { r.refs.sort(compareRefs); r.quantity = r.refs.length }
  return rows.sort((a, b) => compareRefs(a.refs[0] ?? '', b.refs[0] ?? ''))
}

/** One ungrouped row per schematic component, optionally limited to some fields. */
export function bomItemsFromNetlist(n: ParsedNetlist, fields?: string[]): BomRow[] {
  const keep = fields && new Set(fields)
  return n.components
    .filter(c => !c.ref.startsWith('#'))
    .map(c => ({
      refs: [c.ref], quantity: 1, value: c.value, footprint: c.footprint,
      fields: keep ? Object.fromEntries(Object.entries(c.fields).filter(([k]) => keep.has(k))) : { ...c.fields },
      dnp: c.dnp, excludeFromBom: c.excludeFromBom,
    }))
    .sort((a, b) => compareRefs(a.refs[0]!, b.refs[0]!))
}

/** One ungrouped row per footprint of the board (when there is no schematic). */
export function bomItemsFromFootprints(fps: Footprint[], fields?: string[]): BomRow[] {
  const keep = fields && new Set(fields)
  return fps
    .filter(f => f.ref && !f.ref.startsWith('#') && !/^(REF|kibuzzard)/i.test(f.ref))
    .map(f => {
      const all = Object.fromEntries(Object.entries(f.fields).filter(([k, v]) => !blank(v) && !k.startsWith('ki_') && k !== 'Sheetname' && k !== 'Sheetfile'))
      return {
        refs: [f.ref], quantity: 1, value: f.value, footprint: f.footprint,
        fields: keep ? Object.fromEntries(Object.entries(all).filter(([k]) => keep.has(k))) : all,
        dnp: f.dnp, excludeFromBom: f.excludeFromBom,
      }
    })
    .sort((a, b) => compareRefs(a.refs[0]!, b.refs[0]!))
}
