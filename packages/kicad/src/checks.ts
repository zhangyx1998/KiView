// DRC / ERC report parsing [P2-d]: `kicad-cli pcb drc --format json` and
// `kicad-cli sch erc --format json` (schemas.kicad.org/drc.v1.json, erc.v1.json)
// into the CheckReport contract.
//
// ERC positions: kicad-cli (7 ... 10.0.6 at least) writes ERC item positions in
// units of 100 mm although the report says "coordinate_units": "mm" (a symbol at
// (36.83, 97.79) is reported as (0.3683, 0.9779)). No schematic sheet is smaller
// than 10 mm, so when every ERC position lies within 10 units the report is scaled
// by 100; a fixed KiCad then passes through unchanged.

import type { CheckReport, CheckViolation, Point, Severity } from './types.ts'

const SEVERITIES: Severity[] = ['error', 'warning', 'exclusion', 'info']

function severityOf(v: unknown): Severity {
  const s = String(v ?? '').toLowerCase()
  return (SEVERITIES as string[]).includes(s) ? (s as Severity) : s === 'ignore' ? 'exclusion' : 'warning'
}

function unitScale(units: unknown): number {
  const u = String(units ?? 'mm').toLowerCase()
  return u === 'in' ? 25.4 : u === 'mils' || u === 'mil' ? 0.0254 : 1
}

function violation(v: any, scale: number, sheet?: string): CheckViolation {
  const items = Array.isArray(v?.items) ? v.items : []
  return {
    type: String(v?.type ?? 'unknown'),
    severity: severityOf(v?.severity),
    description: String(v?.description ?? ''),
    items: items.map((it: any) => {
      const p = it?.pos
      const pos: Point | null = p && Number.isFinite(p.x) && Number.isFinite(p.y) ? { x: p.x * scale, y: p.y * scale } : null
      const d = String(it?.description ?? '')
      const ref = (/^(?:Footprint|Symbol)\s+([A-Za-z#][\w#]*)/.exec(d) ?? /^Pad\b.*?\bof\s+([A-Za-z#][\w#]*)/.exec(d))?.[1]
      return { description: String(it?.description ?? ''), pos, ...(sheet !== undefined ? { sheet } : {}), ...(ref ? { ref } : {}) }
    }),
  }
}

export function countSeverities(list: CheckViolation[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { error: 0, warning: 0, exclusion: 0, info: 0 }
  for (const v of list) counts[v.severity]++
  return counts
}

/** Parse a kicad-cli DRC or ERC JSON report. */
export function parseCheckReport(text: string, kind: 'drc' | 'erc'): CheckReport {
  const j = JSON.parse(text)
  const scale = unitScale(j?.coordinate_units)
  let violations: CheckViolation[]
  let unconnected: CheckViolation[] = []
  let parity: CheckViolation[] = []
  if (kind === 'drc') {
    violations = (j?.violations ?? []).map((v: any) => violation(v, scale))
    unconnected = (j?.unconnected_items ?? []).map((v: any) => violation(v, scale))
    parity = (j?.schematic_parity ?? []).map((v: any) => violation(v, scale))
  } else {
    const sheets: any[] = Array.isArray(j?.sheets) ? j.sheets : []
    violations = sheets.flatMap(s => (s?.violations ?? []).map((v: any) => violation(v, scale, String(s?.path ?? '/'))))
    const pts = violations.flatMap(v => v.items.map(i => i.pos)).filter((p): p is Point => !!p)
    if (pts.length && pts.every(p => Math.abs(p.x) <= 10 && Math.abs(p.y) <= 10))
      for (const v of violations) for (const i of v.items) if (i.pos) i.pos = { x: Math.round(i.pos.x * 1e6) / 1e4, y: Math.round(i.pos.y * 1e6) / 1e4 }
  }
  return {
    kind,
    kicadVersion: typeof j?.kicad_version === 'string' ? j.kicad_version : null,
    date: typeof j?.date === 'string' ? j.date : null,
    violations,
    unconnected,
    parity,
    counts: countSeverities([...violations, ...unconnected, ...parity]),
  }
}
