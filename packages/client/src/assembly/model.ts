// Assembly-mode view model (pure, no Vue): the step list built from the BOM groups and
// the placed footprints, its default order, the "leave empty" list, per-part notes and
// build variants.
//
// One step per BOM line (value + footprint + fields, kicad netlist.ts groupBom) and side:
// a line with parts on both sides becomes two steps. A variant's value override moves
// that part to a step of its own; a variant's fit / dnp lists move parts in or out of
// the steps. Without a BOM (no schematic) the footprints are grouped by value and
// footprint instead.
//
// Default order:
//   1. side, as configured (`sideOrder`, back first by default);
//   2. the explicit `order` (refdes), when given: listed steps first, in that order;
//   3. SMD before through-hole (before anything else);
//   4. low and small before tall: a height class from the package (chip passives,
//      small discretes / LEDs, ICs, tall SMD parts, connectors, modules);
//   5. package, then value, then the first refdes.

import type { BoardAssembly, BomRow, Footprint, NetlistData } from '@kiview/vite-plugin/contract'

import { detectPolarity, type PinInfo, type Polarity } from './polarity.ts'

export type Side = 'front' | 'back'
export type Mount = 'smd' | 'tht' | 'other'

export interface StepPart {
  ref: string
  footprint: Footprint | null
  polarity: Polarity | null
  /** Notes for this part (config refNotes, note fields, variant value change). */
  notes: string[]
}

export interface Step {
  /** Stable within a board: side, value, footprint and the first ref. */
  id: string
  side: Side | null
  mount: Mount
  value: string
  /** Value as designed when a variant changed it. */
  designValue: string | null
  footprint: string
  /** Package as read from the footprint name, e.g. "SOIC-18W", "1206", "4014". */
  pkg: string
  mpn: string
  manufacturer: string
  refs: string[]
  parts: StepPart[]
  /** The step's polarity summary: the first part's kind and label ("Cathode W"), or null. */
  polarity: Polarity | null
  /** True when the parts disagree on the marked pad's direction (rotated copies). */
  mixedDirections: boolean
  heightClass: number
  description: string
  datasheet: string | null
}

export interface EmptyPart { ref: string; value: string; footprint: string; side: Side | null; notes: string[] }

export interface AssemblyPlan { steps: Step[]; empty: EmptyPart[]; total: number }

export interface PlanInput {
  rows: readonly BomRow[] | null
  footprints: readonly Footprint[]
  netlist?: NetlistData | null
  assembly?: BoardAssembly | null
  /** Variant id (Board.assembly.variants), or null for the board as designed. */
  variant?: string | null
}

const MPN_FIELD = /^(mpn|manufacturer.?part.?(number|no\.?|#)?|part.?(number|no\.?|#)|mfr.?(pn|part.?number)|mfg.?(pn|part.?number))$/i
const MFR_FIELD = /^(manufacturer|mfr|mfg|maker)$/i
const fieldMatching = (fields: Record<string, string>, re: RegExp) => Object.entries(fields).find(([k]) => re.test(k))?.[1] ?? ''

/** "R2" < "R10"; "U1A" after "U1". */
export function compareRefs(a: string, b: string): number {
  const pa = /^(\D*)(\d*)(.*)$/.exec(a)!, pb = /^(\D*)(\d*)(.*)$/.exec(b)!
  return pa[1]!.localeCompare(pb[1]!) || (Number(pa[2] || -1) - Number(pb[2] || -1)) || pa[3]!.localeCompare(pb[3]!)
}

const shortFp = (f: string) => f.slice(f.indexOf(':') + 1)

// package tokens; `_` counts as a separator (KiCad names are snake-ish), so no \b
const B = '(?<![A-Za-z0-9])', E = '(?![A-Za-z0-9])'
const PKG_PATTERNS: RegExp[] = [
  `(?:HT?SSOP|TSSOP|MSOP|SOIC|SOP|SO|QSOP|VSSOP|TSOP)-?\\d+(?:W|N)?`,
  `(?:V|W|U|X)?(?:QFN|DFN|LGA|BGA|QFP|LQFP|TQFP|PQFP|SON|WSON|VSON|TDFN|UDFN)-?\\d+(?:-\\d+)?`,
  `SOT-?\\d+(?:-\\d+)?`, `SOD-?\\d+`, `TO-?\\d+(?:-\\d+)?`, `DO-?\\d+[A-Z]*`,
  `(?:Mini)?MELF`, `SM[ABC]`, `DIP-?\\d+`, `PowerPAK[\\w-]*?(?=_|$)`,
  `(?:01005|0201|0402|0603|0805|1008|1206|1210|1806|1812|2010|2220|2512|2816|3014|3528|4014|5050|5730)`,
].map(p => new RegExp(B + p + E, 'i'))

/** Package of a footprint id, for display and sorting ("SOIC-18W", "1206", "4014"), else the footprint name. */
export function packageOf(footprint: string): string {
  const name = shortFp(footprint)
  for (const re of PKG_PATTERNS) {
    const m = re.exec(name)
    if (m) return m[0]
  }
  return name
}

/** SMD, through-hole, or other (mechanical, no copper pads). */
export function mountOf(fp: Footprint | null | undefined, footprint = ''): Mount {
  if (fp) {
    if (fp.pads.some(p => p.type === 'thru_hole')) return 'tht'
    if (fp.pads.some(p => p.type === 'smd' || p.type === 'connect')) return 'smd'
    return 'other'
  }
  return /THT|_Vertical|_Horizontal|DIP|TO-?220|PinHeader|PinSocket|Axial|Radial/i.test(footprint) ? 'tht' : 'smd'
}

/**
 * Low to tall, from the package: 0 chip passives / small chip LEDs; 1 small discretes,
 * LEDs, DFN / QFN; 2 ICs (SOIC, SSOP, QFP, SOT-223, power packages); 3 tall SMD parts
 * (electrolytics, power inductors, crystals, buttons, SMD connectors); 4 through-hole
 * passives and DIP ICs; 5 connectors and headers; 6 modules and boards.
 */
export function heightClass(footprint: string, ref: string, mount: Mount): number {
  const n = shortFp(footprint)
  if (/Module|Arduino|ESP32|ESP-?\d|Raspberry|Pico|Castellated|Nano|Feather|Breakout/i.test(n) || /^(A|M|MOD)\d/i.test(ref)) return 6
  const conn = /^(J|P|CN|CON|X|XS|XP)\d/i.test(ref) || /Header|Socket|Connector|IDC|JST|Molex|USB|Terminal|Barrel|Jack|FFC|FPC/i.test(n)
  if (mount === 'tht') return conn ? 5 : /DIP|SIP/i.test(n) ? 4 : /CP_|Elec|Radial/i.test(n) ? 5 : 4
  if (conn) return 3
  if (/CP_Elec|Elec|Tantal|Crystal|HC-?49|Button|Switch|SW_|Buzzer|Inductor|L_\d{4}|Bourns_SR|Coilcraft|Fuseholder|Battery/i.test(n) || /^(SW|BT|Y|BZ)\d/i.test(ref)) return 3
  if (/SOIC|SSOP|TSSOP|MSOP|QFP|BGA|LGA|SOT-?223|TO-?\d|DPAK|D2PAK|PowerPAK|SO-?\d|TSOP|PLCC/i.test(n)) return 2
  if (/SOT|SOD|SM[ABC]\b|MELF|DFN|QFN|SON\b|WSON|LED|4014|3528|5050|3014|5730/i.test(n)) return 1
  if (/(^|_)(01005|0201|0402|0603|0805|1206|1210|1812|2010|2512)(_|Metric|$)/.test(n) || /^(R|C|L|FB|D|F|RN)\d/i.test(ref)) return 0
  return 2
}

/** Pin facts by pad number for one ref, from the netlist nodes. */
export function pinsOf(netlist: NetlistData | null | undefined): Map<string, PinInfo> {
  const out = new Map<string, PinInfo>()
  for (const net of netlist?.nets ?? []) for (const n of net.nodes) {
    let m = out.get(n.ref)
    if (!m) out.set(n.ref, m = new Map())
    if (!m.has(n.pin)) m.set(n.pin, { fn: n.pinFunction, type: n.pinType })
  }
  return out
}

interface PartRec { ref: string; row: BomRow; rowIndex: number; fp: Footprint | null; value: string; designValue: string | null; dnp: boolean }

/** Build the step list and the "leave empty" list. */
export function buildPlan(input: PlanInput): AssemblyPlan {
  const a = input.assembly ?? null
  const variant = a?.variants.find(v => v.id === input.variant) ?? null
  const fpByRef = new Map(input.footprints.map(f => [f.ref, f]))
  const pins = pinsOf(input.netlist)
  const fit = new Set(variant?.fit ?? []), unfit = new Set(variant?.dnp ?? [])
  const noteFields = a?.noteFields ?? []

  // the BOM lines, or footprints grouped by value + footprint when there is no BOM
  const rows: BomRow[] = input.rows ? [...input.rows] : groupFootprints(input.footprints)

  const parts: PartRec[] = []
  rows.forEach((row, rowIndex) => {
    if (row.excludeFromBom && !row.dnp && !row.refs.some(r => fit.has(r))) return
    for (const ref of row.refs) {
      const fp = fpByRef.get(ref) ?? null
      const override = variant?.values[ref]
      const dnp = fit.has(ref) ? false : unfit.has(ref) ? true : row.dnp
      parts.push({ ref, row, rowIndex, fp, value: override ?? row.value, designValue: override && override !== row.value ? row.value : null, dnp })
    }
  })

  const notesOf = (p: PartRec): string[] => {
    const out: string[] = []
    const cfg = a?.refNotes[p.ref]
    if (cfg) out.push(cfg)
    for (const f of noteFields) {
      const v = (p.fp?.fields[f] ?? p.row.fields[f] ?? '').trim()
      if (v && !out.includes(v)) out.push(v)
    }
    if (p.designValue !== null) out.push(`${variant!.label}: ${p.value} (designed ${p.designValue})`)
    if (variant && fit.has(p.ref) && p.row.dnp) out.push(`${variant.label}: fitted (DNP as designed)`)
    return out
  }

  // fitted parts -> steps, grouped by BOM line, side and effective value
  const groups = new Map<string, PartRec[]>()
  const empty: EmptyPart[] = []
  for (const p of parts) {
    if (p.fp && mountOf(p.fp) === 'other') continue   // mounting holes, fiducials, logos: nothing to fit
    if (p.dnp) {
      empty.push({ ref: p.ref, value: p.value, footprint: p.row.footprint, side: p.fp?.side ?? null, notes: notesOf(p) })
      continue
    }
    const key = `${p.rowIndex}\0${p.fp?.side ?? ''}\0${p.value}`
    let g = groups.get(key)
    if (!g) groups.set(key, g = [])
    g.push(p)
  }

  const steps: Step[] = []
  for (const list of groups.values()) {
    list.sort((x, y) => compareRefs(x.ref, y.ref))
    const first = list[0]!
    const row = first.row
    const side = first.fp?.side ?? null
    const mount = mountOf(first.fp, row.footprint)
    const stepParts: StepPart[] = list.map(p => ({
      ref: p.ref, footprint: p.fp, notes: notesOf(p),
      polarity: p.fp ? detectPolarity(p.fp, pins.get(p.ref)) : null,
    }))
    const pol = stepParts.find(s => s.polarity)?.polarity ?? null
    const dirs = new Set(stepParts.map(s => s.polarity?.dir ?? null))
    const datasheet = /^https?:\/\//.test(row.fields.Datasheet ?? '') ? row.fields.Datasheet! : null
    steps.push({
      id: `${side ?? '-'}|${first.value}|${row.footprint}|${first.ref}`,
      side, mount, value: first.value, designValue: first.designValue,
      footprint: row.footprint, pkg: packageOf(row.footprint),
      mpn: fieldMatching(row.fields, MPN_FIELD), manufacturer: fieldMatching(row.fields, MFR_FIELD),
      refs: list.map(p => p.ref), parts: stepParts, polarity: pol, mixedDirections: !!pol && dirs.size > 1,
      heightClass: heightClass(row.footprint, first.ref, mount),
      description: row.fields.Description ?? '', datasheet,
    })
  }
  empty.sort((x, y) => compareRefs(x.ref, y.ref))
  return { steps: sortSteps(steps, a), empty, total: steps.reduce((n, s) => n + s.refs.length, 0) }
}

const MOUNT_RANK: Record<Mount, number> = { smd: 0, tht: 1, other: 2 }

/** The default order (see the file header). */
export function sortSteps(steps: Step[], a: Pick<BoardAssembly, 'sideOrder' | 'order'> | null): Step[] {
  const sideOrder = a?.sideOrder ?? ['back', 'front']
  const sideRank = (s: Side | null) => (s ? sideOrder.indexOf(s) : 2)
  const orderIdx = new Map((a?.order ?? []).map((r, i) => [r, i] as const))
  const explicit = (s: Step) => Math.min(...s.refs.map(r => orderIdx.get(r) ?? Infinity))
  return [...steps].sort((x, y) =>
    sideRank(x.side) - sideRank(y.side)
    || cmpNum(explicit(x), explicit(y))
    || MOUNT_RANK[x.mount] - MOUNT_RANK[y.mount]
    || x.heightClass - y.heightClass
    || x.pkg.localeCompare(y.pkg, undefined, { numeric: true, sensitivity: 'base' })
    || x.value.localeCompare(y.value, undefined, { numeric: true, sensitivity: 'base' })
    || compareRefs(x.refs[0]!, y.refs[0]!))
}
const cmpNum = (a: number, b: number) => (a === b ? 0 : a < b ? -1 : 1)

/** BOM-like lines from the footprints alone (value + footprint + DNP), for boards without a schematic. */
export function groupFootprints(fps: readonly Footprint[]): BomRow[] {
  const m = new Map<string, BomRow>()
  for (const f of fps) {
    if (!f.ref || f.excludeFromBom && !f.dnp) continue
    const key = `${f.value}\0${f.footprint}\0${f.dnp}`
    let r = m.get(key)
    if (!r) m.set(key, r = { refs: [], quantity: 0, value: f.value, footprint: f.footprint, fields: { ...f.fields }, dnp: f.dnp, excludeFromBom: false })
    r.refs.push(f.ref)
    r.quantity++
  }
  return [...m.values()]
}
