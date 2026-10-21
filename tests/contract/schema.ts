// Structural validation of what the virtual modules hand the client
// (packages/vite-plugin/src/contract.ts): `virtual:kiview/boards` -> Board[],
// `virtual:kiview/site` -> SiteData. No dependencies: a tiny schema DSL whose
// validators return a list of "path: problem" strings (empty when valid).
//
// Keep this in step with contract.ts (merged contract of phase 2, documented in
// docs/architecture.md). Fields that phase 2 fills are validated by shape when present
// and are null when the feature is unavailable (the features check in features.ts ties
// them to Board.features). Additive optional fields are `optional(...)`. The payloads
// behind the asset URLs (BOM, parts, netlist, geometry, DRC / ERC reports) have their
// own schemas below; the runner validates the built files with them.

import { FEATURES, type FeatureId } from '@kiview/kicad'

export type Problems = string[]
export type Check = (v: unknown, path: string, out: Problems) => void

const typeOf = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v)
const fail = (out: Problems, path: string, msg: string, v: unknown) =>
  out.push(`${path || '<root>'}: ${msg} (got ${typeOf(v)}${typeof v === 'string' ? ` "${v.slice(0, 40)}"` : ''})`)

export const str: Check = (v, p, o) => { if (typeof v !== 'string') fail(o, p, 'expected a string', v) }
export const nonEmpty: Check = (v, p, o) => { if (typeof v !== 'string' || !v) fail(o, p, 'expected a non-empty string', v) }
export const num: Check = (v, p, o) => { if (typeof v !== 'number' || !Number.isFinite(v)) fail(o, p, 'expected a finite number', v) }
export const int: Check = (v, p, o) => { if (!Number.isInteger(v)) fail(o, p, 'expected an integer', v) }
export const nonNeg: Check = (v, p, o) => { if (typeof v !== 'number' || !(v >= 0)) fail(o, p, 'expected a number >= 0', v) }
export const bool: Check = (v, p, o) => { if (typeof v !== 'boolean') fail(o, p, 'expected a boolean', v) }
export const oneOf = (...values: unknown[]): Check => (v, p, o) => {
  if (!values.includes(v)) fail(o, p, `expected one of ${values.map(x => JSON.stringify(x)).join(', ')}`, v)
}
export const matches = (re: RegExp, what: string): Check => (v, p, o) => {
  if (typeof v !== 'string' || !re.test(v)) fail(o, p, `expected ${what}`, v)
}
export const nullable = (c: Check): Check => (v, p, o) => { if (v !== null) c(v, p, o) }
export const optional = (c: Check): Check => (v, p, o) => { if (v !== undefined) c(v, p, o) }
export const arrayOf = (c: Check): Check => (v, p, o) => {
  if (!Array.isArray(v)) return fail(o, p, 'expected an array', v)
  v.forEach((x, i) => c(x, `${p}[${i}]`, o))
}
export const recordOf = (c: Check): Check => (v, p, o) => {
  if (typeOf(v) !== 'object') return fail(o, p, 'expected an object', v)
  for (const [k, x] of Object.entries(v as object)) c(x, `${p}.${k}`, o)
}
/** An object with exactly these keys (extra keys are reported: the contract is closed). */
export const object = (shape: Record<string, Check>, { extra = false } = {}): Check => (v, p, o) => {
  if (typeOf(v) !== 'object') return fail(o, p, 'expected an object', v)
  const rec = v as Record<string, unknown>
  for (const [k, c] of Object.entries(shape)) c(rec[k], p ? `${p}.${k}` : k, o)
  if (!extra) for (const k of Object.keys(rec)) if (!(k in shape)) o.push(`${p ? `${p}.${k}` : k}: unexpected field`)
}
export const all = (...cs: Check[]): Check => (v, p, o) => { for (const c of cs) c(v, p, o) }

/** An asset URL: absolute path under the base (or a full URL when base is one). */
export const url: Check = matches(/^(\/|https?:\/\/)\S*$/, 'a URL starting with / or http(s)://')

// ---- the contract ------------------------------------------------------------------

const rect = object({ x: num, y: num, width: nonNeg, height: nonNeg })
const point = object({ x: num, y: num })
const size = object({ width: nonNeg, height: nonNeg })
const titleBlock = object({ title: nullable(str), rev: nullable(str), date: nullable(str), company: nullable(str), comments: arrayOf(str) })
const assetRef = object({ url, bytes: nonNeg })
const severityCounts = object({ error: nonNeg, warning: nonNeg, exclusion: nonNeg, info: nonNeg })
const reportSummary = object({ url, counts: severityCounts })

const featureStatus: Check = (v, p, o) => {
  if (typeOf(v) !== 'object') return fail(o, p, 'expected a FeatureStatus object', v)
  const s = v as Record<string, unknown>
  if (s.available === true) object({ available: bool })(v, p, o)
  else if (s.available === false) object({ available: bool, reason: nonEmpty })(v, p, o)
  else fail(o, `${p}.available`, 'expected true or false', s.available)
}

/** Board.features must list every FeatureId (features.ts FEATURES), nothing else. */
const features: Check = (v, p, o) => {
  if (typeOf(v) !== 'object') return fail(o, p, 'expected an object', v)
  const rec = v as Record<string, unknown>
  for (const id of Object.keys(FEATURES) as FeatureId[]) {
    if (!(id in rec)) o.push(`${p}.${id}: missing feature`)
    else featureStatus(rec[id], `${p}.${id}`, o)
  }
  for (const k of Object.keys(rec)) if (!(k in FEATURES)) o.push(`${p}.${k}: unknown feature`)
}

const layer = object({
  id: nonEmpty,
  name: nonEmpty,
  kind: oneOf('copper', 'silkscreen', 'mask', 'paste', 'fab', 'courtyard', 'edge', 'other'),
  side: oneOf('front', 'back', 'inner', 'both'),
  url,
  color: nonEmpty,
  order: all(int, nonNeg),
})

const sheetRef = object({
  path: nonEmpty, name: str, source: nonEmpty, page: str, parent: nullable(str), url, titleBlock,
  symbols: arrayOf(object({ ref: nonEmpty, bbox: rect })),
  symbolBox: optional(nullable(rect)),   // [P2-b] the sheet's symbol on its parent
})

const sideParts = object({ smd: nonNeg, tht: nonNeg, other: nonNeg })
const stats = object({
  size, copperLayers: all(int, nonNeg), thickness: nullable(num),
  footprints: object({ front: nonNeg, back: nonNeg, smd: nonNeg, tht: nonNeg }),
  pads: nonNeg, vias: nonNeg,
  holes: object({ plated: nonNeg, nonPlated: nonNeg, minDiameter: nullable(num) }),
  minTrack: nullable(num), minClearance: nullable(num),
  // [P2-d] additive
  layerCount: optional(all(int, nonNeg)),
  area: optional(nullable(nonNeg)),
  parts: optional(object({ front: sideParts, back: sideParts })),
  padTypes: optional(object({ smd: nonNeg, tht: nonNeg, npth: nonNeg })),
  tracks: optional(object({ count: nonNeg, length: nonNeg, widths: arrayOf(object({ width: nonNeg, count: nonNeg })) })),
  viaSizes: optional(arrayOf(object({ size: nonNeg, drill: nonNeg, type: oneOf('through', 'blind', 'buried', 'micro'), count: nonNeg }))),
  drills: optional(arrayOf(object({ width: nonNeg, height: nonNeg, plated: bool, source: oneOf('pad', 'via'), count: nonNeg }))),
  minAnnularRing: optional(nullable(num)),
  rules: optional(object({
    minClearance: nullable(num), minTrackWidth: nullable(num), minViaDiameter: nullable(num), minViaAnnularRing: nullable(num),
    minHoleDiameter: nullable(num), minHoleToHole: nullable(num), minCopperEdgeClearance: nullable(num),
  })),
  stackup: optional(object({
    maskColor: object({ front: nullable(str), back: nullable(str) }),
    silkColor: object({ front: nullable(str), back: nullable(str) }),
    finish: nullable(str), thickness: nullable(num), copperLayers: all(int, nonNeg),
    layers: arrayOf(object({ name: str, type: str, thickness: nullable(num), material: nullable(str), epsilonR: nullable(num), color: nullable(str) })),
  })),
  source: optional(oneOf('file', 'file+kicad-cli')),
})

// [P2-c] fab deliverables, revision diff
const fabItem = object({
  id: oneOf('gerbers', 'drill', 'drillMap', 'ipcd356', 'pos', 'bom', 'schematicPdf', 'model'),
  label: nonEmpty, required: bool, status: oneOf('ok', 'skipped', 'failed'), files: arrayOf(str), reason: nullable(str),
})
const layerDiff = object({
  id: nonEmpty, name: nonEmpty, kind: oneOf('copper', 'silkscreen', 'mask', 'paste', 'fab', 'courtyard', 'edge', 'other'),
  side: oneOf('front', 'back', 'inner', 'both'), color: nonEmpty, order: all(int, nonNeg),
  status: oneOf('changed', 'added', 'removed', 'unchanged'), before: nullable(url), after: nullable(url),
})
const boardDiff = object({
  ref: nonEmpty,
  base: nullable(object({ commit: matches(/^[0-9a-f]{40,64}$/, 'a commit id'), short: nonEmpty, tag: nullable(str), date: nonEmpty, subject: str })),
  note: nullable(str),
  bounds: rect,
  outlineChanged: bool,
  layers: arrayOf(layerDiff),
  parts: nullable(object({ added: arrayOf(str), removed: arrayOf(str), moved: arrayOf(str), changed: arrayOf(str) })),
  summary: str,
})

// [assembly] assembly-mode settings (stage `assembly`), BOM options (config bom.showDnp)
const assembly = object({
  sideOrder: all(arrayOf(oneOf('front', 'back')), (v, p, o) => {
    if (Array.isArray(v) && (v.length !== 2 || new Set(v).size !== 2)) o.push(`${p}: expected both sides once`)
  }),
  notes: arrayOf(object({ source: nonEmpty, markdown: str })),
  refNotes: recordOf(str),
  noteFields: arrayOf(nonEmpty),
  order: arrayOf(nonEmpty),
  variants: arrayOf(object({
    id: nonEmpty, label: nonEmpty, fit: arrayOf(nonEmpty), dnp: arrayOf(nonEmpty), values: recordOf(str), note: nullable(str),
  })),
})

export const boardSchema: Check = object({
  name: matches(/^[^/\\]+$/, 'a board name without slashes'),
  title: nonEmpty,
  model: nullable(object({ url, format: oneOf('glb', 'vrml'), bytes: nonNeg })),
  layers: arrayOf(layer),
  bounds: rect,
  size,
  thumbnail: nullable(object({ url, width: all(int, nonNeg), height: all(int, nonNeg) })),   // PNG render, or the SVG composite (P2-a)
  copperLayers: all(int, nonNeg),
  revision: matches(/^([0-9a-f]{12}|\?)$/, '12 hex digits'),
  download: optional(object({
    url, filename: nonEmpty, bytes: nonNeg, status: oneOf('ok', 'incomplete'), missing: arrayOf(str), contents: arrayOf(str),
    items: optional(arrayOf(fabItem)),   // [P2-c]
  })),
  maskColor: nullable(str),
  titleBlock,
  kicad: object({
    formatVersion: all(int, nonNeg), minKicad: all(int, nonNeg),
    exportedWith: nullable(str), backend: nullable(oneOf('cli-modern', 'cli-7-8', 'pcbnew-python', 'docker')),
  }),
  files: object({ pcb: matches(/\.kicad_pcb$/, 'a .kicad_pcb path'), sch: nullable(matches(/\.kicad_sch$/, 'a .kicad_sch path')), pro: nullable(matches(/\.kicad_pro$/, 'a .kicad_pro path')) }),
  features,
  rev: object({
    hash: matches(/^([0-9a-f]{12}|\?)$/, '12 hex digits'),
    titleBlock: nullable(str), version: nullable(str),
    git: nullable(object({
      commit: matches(/^[0-9a-f]{40,64}$/, 'a commit id'), short: nonEmpty, tag: nullable(str), dirty: bool, date: nonEmpty,
      describe: optional(nullable(str)), subject: optional(str),   // [P2-c]
    })),
    label: nonEmpty,
  }),
  schematic: nullable(object({ sheets: arrayOf(sheetRef) })),
  bom: nullable(assetRef),
  parts: nullable(assetRef),
  netlist: nullable(assetRef),
  diff: optional(nullable(boardDiff)),   // [P2-c] opt-in
  stats: nullable(stats),
  reports: object({ drc: nullable(reportSummary), erc: nullable(reportSummary) }),
  geometry: optional(nullable(assetRef)),   // [P2-d] GeometryData
  assembly: optional(nullable(assembly)),   // [assembly]
  bomOptions: optional(object({ showDnp: bool })),   // [assembly]
})

// ---- payloads behind the asset URLs ------------------------------------------------

const pad = object({
  number: str, type: oneOf('smd', 'thru_hole', 'np_thru_hole', 'connect'),
  shape: oneOf('circle', 'rect', 'oval', 'trapezoid', 'roundrect', 'chamfered_rect', 'custom'),
  at: point, rotation: num, size, drill: nullable(size), layers: arrayOf(nonEmpty),
  net: nullable(object({ code: int, name: str })),
  pinFunction: optional(str), pinType: optional(str),
})
const footprint = object({
  ref: str, value: str, footprint: str, side: oneOf('front', 'back'), at: point, rotation: num, bbox: rect,
  pads: arrayOf(pad), fields: recordOf(str), dnp: bool, excludeFromBom: bool, excludeFromPos: bool, path: nullable(str),
})
const bomRow = object({
  refs: arrayOf(nonEmpty), quantity: all(int, nonNeg), value: str, footprint: str, fields: recordOf(str), dnp: bool, excludeFromBom: bool,
})
const net = object({
  code: int, name: str, netClass: optional(str),
  nodes: arrayOf(object({ ref: nonEmpty, pin: str, pinFunction: optional(str), pinType: optional(str) })),
})
const flat: Check = (v, p, o) => {
  arrayOf(num)(v, p, o)
  if (Array.isArray(v) && v.length % 2) fail(o, p, 'expected an even number of coordinates', v)
}
const violation = object({
  type: str, severity: oneOf('error', 'warning', 'exclusion', 'info'), description: str,
  items: arrayOf(object({ description: str, pos: nullable(point), sheet: optional(str), ref: optional(str) })),
})

/** Board.bom.url (BomData) */
export const bomDataSchema: Check = object({ rows: arrayOf(bomRow), fields: arrayOf(str) })
/** Board.parts.url (PartsData) */
export const partsDataSchema: Check = object({ footprints: arrayOf(footprint), thickness: optional(nullable(num)) })
/** Board.netlist.url (NetlistData) */
export const netlistDataSchema: Check = object({ nets: arrayOf(net) })
/** Board.geometry.url (GeometryData) */
export const geometryDataSchema: Check = object({
  nets: arrayOf(str), copper: arrayOf(nonEmpty),
  tracks: arrayOf(object({ net: all(int, nonNeg), layer: nonEmpty, width: nonNeg, pts: flat })),
  vias: arrayOf(object({ net: all(int, nonNeg), at: point, size: nonNeg, drill: nonNeg, layers: arrayOf(nonEmpty) })),
  pads: arrayOf(object({
    net: all(int, nonNeg), ref: str, number: str, at: point, rotation: num, shape: oneOf('circle', 'oval', 'rect', 'roundrect'),
    size, drill: nullable(size), layers: arrayOf(nonEmpty),
  })),
  zones: arrayOf(object({ net: all(int, nonNeg), layer: nonEmpty, pts: flat })),
})
/** Board.reports.{drc,erc}.url (CheckReport) */
export const checkReportSchema: Check = object({
  kind: oneOf('drc', 'erc'), kicadVersion: nullable(str), date: nullable(str),
  violations: arrayOf(violation), unconnected: arrayOf(violation), parity: arrayOf(violation), counts: severityCounts,
})

/** Problems with one payload (path prefix: what it is). */
export function validatePayload(schema: Check, v: unknown, what: string): Problems {
  const out: Problems = []
  schema(v, what, out)
  return out
}

export const siteSchema: Check = object({
  title: nonEmpty,
  description: nullable(str),
  logo: nullable(str),
  theme: object({ appearance: oneOf('dark', 'light', 'auto'), accent: nullable(str), vars: recordOf(str) }),
  single: nullable(nonEmpty),   // the board a single-board site shows (config `single`)
  generator: object({ name: oneOf('kiview'), version: nonEmpty }),
  kicad: str,
})

/** Problems with the boards module payload: each board, unique names, sorted by name. */
export function validateBoards(v: unknown): Problems {
  const out: Problems = []
  arrayOf(boardSchema)(v, 'boards', out)
  if (Array.isArray(v)) {
    const names = v.map(b => (b as { name?: unknown }).name).filter((n): n is string => typeof n === 'string')
    if (new Set(names).size !== names.length) out.push('boards: duplicate board names')
    const sorted = [...names].sort((a, b) => a.localeCompare(b))
    if (names.join('\0') !== sorted.join('\0')) out.push('boards: not sorted by name')
  }
  return out
}

export function validateSite(v: unknown): Problems {
  const out: Problems = []
  siteSchema(v, 'site', out)
  return out
}
