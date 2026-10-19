// BOM view model (pure, no Vue): the grouped rows of bom.json expanded to one row per
// part, search, sorting, and the fitted / DNP / not-in-BOM sections.
//
// bom.json rows are grouped by value + footprint + fields (kicad netlist.ts
// groupBom), so expanding a row's refs is lossless: the ungrouped view needs no
// second file.

import type { BomRow } from '@kiview/vite-plugin/contract'

export type SortKey = 'refs' | 'quantity' | 'value' | 'footprint' | `field:${string}`
export interface Sort { key: SortKey; dir: 1 | -1 }

/** "R2" < "R10"; "U1A" after "U1". */
export function compareRefs(a: string, b: string): number {
  const pa = /^(\D*)(\d*)(.*)$/.exec(a)!, pb = /^(\D*)(\d*)(.*)$/.exec(b)!
  return pa[1]!.localeCompare(pb[1]!) || (Number(pa[2] || -1) - Number(pb[2] || -1)) || pa[3]!.localeCompare(pb[3]!)
}

/** One row per reference, quantity 1. */
export function expandRows(rows: readonly BomRow[]): BomRow[] {
  return rows.flatMap(r => r.refs.map(ref => ({ ...r, refs: [ref], quantity: 1 })))
}

const MPN_FIELD = /^(mpn|manufacturer.?part.?(number|no\.?|#)?|part.?(number|no\.?|#)|mfr.?(pn|part.?number)|mfg.?(pn|part.?number))$/i

/** The manufacturer part number of a row, whatever the field is called. */
export function mpnOf(r: BomRow): string {
  for (const [k, v] of Object.entries(r.fields)) if (MPN_FIELD.test(k)) return v
  return ''
}

/** Search over refdes, value and MPN; space-separated terms must all match (case-insensitive). */
export function matches(r: BomRow, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return true
  const hay = [...r.refs, r.value, mpnOf(r)].join(' ').toLowerCase()
  return terms.every(t => hay.includes(t) || r.refs.some(ref => ref.toLowerCase() === t))
}

const text = (r: BomRow, key: SortKey): string =>
  key === 'value' ? r.value : key === 'footprint' ? r.footprint : key.startsWith('field:') ? r.fields[key.slice(6)] ?? '' : ''

export function sortRows(rows: BomRow[], s: Sort): BomRow[] {
  const cmp = (a: BomRow, b: BomRow): number => {
    if (s.key === 'refs') return compareRefs(a.refs[0] ?? '', b.refs[0] ?? '')
    if (s.key === 'quantity') return a.quantity - b.quantity
    return text(a, s.key).localeCompare(text(b, s.key), undefined, { numeric: true, sensitivity: 'base' })
  }
  const textual = s.key !== 'refs' && s.key !== 'quantity'
  return [...rows].sort((a, b) => {
    const ea = textual && !text(a, s.key), eb = textual && !text(b, s.key)
    if (ea !== eb) return ea ? 1 : -1   // empty cells last, whatever the direction
    return s.dir * cmp(a, b) || compareRefs(a.refs[0] ?? '', b.refs[0] ?? '')
  })
}

export interface Sections { fitted: BomRow[]; dnp: BomRow[]; excluded: BomRow[] }

/** Fitted parts, do-not-populate parts, and parts excluded from the BOM (not DNP). */
export function sections(rows: readonly BomRow[]): Sections {
  const out: Sections = { fitted: [], dnp: [], excluded: [] }
  for (const r of rows) (r.dnp ? out.dnp : r.excludeFromBom ? out.excluded : out.fitted).push(r)
  return out
}

/** "Resistor_SMD:R_0603_1608Metric" -> "R_0603_1608Metric". */
export const shortFootprint = (f: string) => f.slice(f.indexOf(':') + 1)

/** The BOM lines the table lists: DNP lines only when `showDnp` (config bom.showDnp; owner rule: DNP parts stay out of a BOM). */
export const visibleRows = (rows: readonly BomRow[], showDnp: boolean): BomRow[] => rows.filter(r => showDnp || !r.dnp)
