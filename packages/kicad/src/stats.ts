// Board statistics [P2-d]: what a board is made of, from the file (always) and from
// `kicad-cli pcb export stats --format json` (KiCad 9+: measured clearance, area,
// component classification) when the backend has it.
//
// computeBoardStats(pcbText, proText?) is a pure parse; parseKicadStatsJson() and
// mergeStats() fold the kicad-cli report in. Units: mm.

import { child, children, head, isList, num, parseSExpr, readBoard, type SExpr } from './board-file.ts'
import { readRawFootprints } from './geometry.ts'
import type { BoardStatsResult, StackupLayer } from './types.ts'

const r4 = (v: number) => Math.round(v * 1e4) / 1e4
const str = (e: SExpr | undefined): string | null => (typeof e === 'string' && e.trim() ? e.trim() : null)
const minOf = (vs: number[]): number | null => (vs.length ? r4(Math.min(...vs)) : null)

function stackupLayers(root: SExpr[]): StackupLayer[] {
  const st = child(child(root, 'setup') ?? [], 'stackup')
  if (!st) return []
  return children(st, 'layer').map(l => {
    const t = num(child(l, 'thickness')?.[1]), er = num(child(l, 'epsilon_r')?.[1])
    return {
      name: str(l[1]) ?? '',
      type: str(child(l, 'type')?.[1]) ?? '',
      thickness: Number.isFinite(t) ? t : null,
      material: str(child(l, 'material')?.[1]),
      epsilonR: Number.isFinite(er) ? er : null,
      color: str(child(l, 'color')?.[1]),
    }
  })
}

type Rules = NonNullable<BoardStatsResult['rules']>

/** Design-rule minimums from a .kicad_pro (JSON); netclass clearances count for min clearance. */
export function readProjectRules(proText: string | null | undefined): Rules | null {
  if (!proText) return null
  let pro: any
  try { pro = JSON.parse(proText) } catch { return null }
  const r = pro?.board?.design_settings?.rules
  if (!r) return null
  const pos = (v: unknown) => (typeof v === 'number' && v > 0 ? v : null)
  const classes: any[] = pro?.net_settings?.classes ?? []
  const classClearance = classes.map(c => c?.clearance).filter((v): v is number => typeof v === 'number' && v > 0)
  const classTrack = classes.map(c => c?.track_width).filter((v): v is number => typeof v === 'number' && v > 0)
  const both = (rule: number | null, cls: number[]) => minOf([...(rule !== null ? [rule] : []), ...cls])
  return {
    minClearance: both(pos(r.min_clearance), classClearance),
    minTrackWidth: both(pos(r.min_track_width), classTrack),
    minViaDiameter: pos(r.min_via_diameter),
    minViaAnnularRing: pos(r.min_via_annular_width),
    minHoleDiameter: pos(r.min_through_hole_diameter),
    minHoleToHole: pos(r.min_hole_to_hole),
    minCopperEdgeClearance: pos(r.min_copper_edge_clearance),
  }
}

/** Statistics from the board file (and the project file for the rules). */
export function computeBoardStats(pcbText: string, proText?: string | null): BoardStatsResult {
  const info = readBoard(pcbText)
  const root = parseSExpr(pcbText).find(e => head(e) === 'kicad_pcb') as SExpr[]
  const fps = readRawFootprints(root)

  const parts = { front: { smd: 0, tht: 0, other: 0 }, back: { smd: 0, tht: 0, other: 0 } }
  for (const f of fps) parts[f.side][f.kind]++

  const padTypes = { smd: 0, tht: 0, npth: 0 }
  const drillKey = new Map<string, NonNullable<BoardStatsResult['drills']>[number]>()
  const addDrill = (w: number, h: number, plated: boolean, source: 'pad' | 'via') => {
    const k = `${r4(w)}x${r4(h)}:${plated}:${source}`
    const d = drillKey.get(k)
    if (d) d.count++
    else drillKey.set(k, { width: r4(w), height: r4(h), plated, source, count: 1 })
  }
  const rings: number[] = []
  let pads = 0
  for (const f of fps) for (const p of f.pads) {
    pads++
    if (p.type === 'np_thru_hole') padTypes.npth++
    else if (p.type === 'thru_hole') padTypes.tht++
    else padTypes.smd++
    if (p.drill && (p.type === 'thru_hole' || p.type === 'np_thru_hole')) {
      addDrill(p.drill.width, p.drill.height, p.type === 'thru_hole', 'pad')
      if (p.type === 'thru_hole' && p.size.width > 0) {
        const ring = Math.min(p.size.width - p.drill.width, p.size.height - p.drill.height) / 2
        if (ring > 0) rings.push(ring)
      }
    }
  }

  const copper = info.stackup.copperLayers
  const viaKey = new Map<string, NonNullable<BoardStatsResult['viaSizes']>[number]>()
  const trackWidths = new Map<number, number>()
  let viaCount = 0, trackCount = 0, trackLen = 0
  for (const e of root) {
    if (!isList(e)) continue
    const h = head(e)
    if (h === 'via') {
      viaCount++
      const size = num(child(e, 'size')?.[1]) || 0, drill = num(child(e, 'drill')?.[1]) || 0
      const layers = (child(e, 'layers')?.slice(1) ?? []).filter((v): v is string => typeof v === 'string')
      const outer = layers.includes('F.Cu') && layers.includes('B.Cu')
      const type = e.includes('micro') ? 'micro' : e.includes('blind') ? (outer ? 'through' : 'blind') : outer || layers.length === 0 ? 'through'
        : layers.includes('F.Cu') || layers.includes('B.Cu') ? 'blind' : 'buried'
      const k = `${size}:${drill}:${type}`
      const v = viaKey.get(k)
      if (v) v.count++
      else viaKey.set(k, { size: r4(size), drill: r4(drill), type, count: 1 })
      if (drill > 0) addDrill(drill, drill, true, 'via')
      if (size > drill && drill > 0) rings.push((size - drill) / 2)
    } else if (h === 'segment' || h === 'arc') {
      const w = num(child(e, 'width')?.[1])
      const s = child(e, 'start'), en = child(e, 'end')
      if (!Number.isFinite(w)) continue
      trackCount++
      trackWidths.set(r4(w), (trackWidths.get(r4(w)) ?? 0) + 1)
      if (s && en) {
        const sx = num(s[1]), sy = num(s[2]), ex = num(en[1]), ey = num(en[2])
        const m = h === 'arc' ? child(e, 'mid') : undefined
        if (m) {
          const mx = num(m[1]), my = num(m[2])
          trackLen += arcLength([sx, sy], [mx, my], [ex, ey])
        } else trackLen += Math.hypot(ex - sx, ey - sy)
      }
    }
  }

  const drills = [...drillKey.values()].sort((a, b) => a.width - b.width || a.height - b.height || Number(b.plated) - Number(a.plated))
  const plated = drills.filter(d => d.plated).reduce((n, d) => n + d.count, 0)
  const nonPlated = drills.filter(d => !d.plated).reduce((n, d) => n + d.count, 0)
  const outline = info.outline
  const widths = [...trackWidths.entries()].map(([width, count]) => ({ width, count })).sort((a, b) => a.width - b.width)

  return {
    size: { width: r4(outline?.width ?? 0), height: r4(outline?.height ?? 0) },
    copperLayers: copper,
    thickness: info.stackup.thickness,
    footprints: {
      front: fps.filter(f => f.side === 'front').length,
      back: fps.filter(f => f.side === 'back').length,
      smd: fps.filter(f => f.kind === 'smd').length,
      tht: fps.filter(f => f.kind === 'tht').length,
    },
    pads,
    vias: viaCount,
    holes: { plated, nonPlated, minDiameter: minOf(drills.map(d => Math.min(d.width, d.height))) },
    minTrack: minOf(widths.map(w => w.width)),
    minClearance: null,
    layerCount: info.layers.length,
    area: null,
    parts,
    padTypes,
    tracks: { count: trackCount, length: Math.round(trackLen * 100) / 100, widths },
    viaSizes: [...viaKey.values()].sort((a, b) => b.count - a.count || a.size - b.size),
    drills,
    minAnnularRing: minOf(rings),
    rules: readProjectRules(proText) ?? undefined,
    stackup: { ...info.stackup, layers: stackupLayers(root) },
    source: 'file',
  }
}

function arcLength(s: [number, number], m: [number, number], e: [number, number]): number {
  const [ax, ay] = s, [bx, by] = m, [cx, cy] = e
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
  if (Math.abs(d) < 1e-12) return Math.hypot(cx - ax, cy - ay)
  const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy
  const ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d
  const uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d
  const r = Math.hypot(ax - ux, ay - uy)
  const norm = (a: number) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
  const a0 = Math.atan2(ay - uy, ax - ux)
  const am = norm(Math.atan2(by - uy, bx - ux) - a0), ae = norm(Math.atan2(cy - uy, cx - ux) - a0)
  return r * (am < ae ? ae : 2 * Math.PI - ae)
}

/** What `kicad-cli pcb export stats --format json` adds (values come as "1.2345 mm"). */
export interface KicadStatsReport {
  width: number | null
  height: number | null
  area: number | null
  thickness: number | null
  minTrack: number | null
  minClearance: number | null
  minDrill: number | null
  parts: NonNullable<BoardStatsResult['parts']> | null
  vias: number | null
}

const mmValue = (v: unknown): number | null => {
  if (typeof v === 'number') return v
  if (typeof v !== 'string') return null
  const m = /^\s*(-?[\d.]+(?:e-?\d+)?)\s*(mm|mm²|in|mils?)?/i.exec(v)
  if (!m) return null
  const n = Number(m[1])
  const unit = (m[2] ?? 'mm').toLowerCase()
  return unit === 'in' ? n * 25.4 : unit.startsWith('mil') ? n * 0.0254 : n
}

export function parseKicadStatsJson(text: string): KicadStatsReport {
  const j = JSON.parse(text)
  const b = j?.board ?? {}
  const c = j?.components
  const side = (s: 'front' | 'back') => ({ smd: c?.smd?.[s] ?? 0, tht: c?.tht?.[s] ?? 0, other: c?.unspecified?.[s] ?? 0 })
  const v = j?.vias
  return {
    width: mmValue(b.width),
    height: mmValue(b.height),
    area: mmValue(b.area),
    thickness: mmValue(b.board_thickness),
    minTrack: mmValue(b.min_track_width),
    minClearance: mmValue(b.min_track_clearance),
    minDrill: mmValue(b.min_drill_diameter),
    parts: c ? { front: side('front'), back: side('back') } : null,
    vias: v ? (v.through ?? 0) + (v.blind ?? 0) + (v.buried ?? 0) + (v.micro ?? 0) : null,
  }
}

/** The file stats with kicad-cli's measured values where it has them. */
export function mergeStats(file: BoardStatsResult, cli: KicadStatsReport | null): BoardStatsResult {
  if (!cli) return file
  const pick = (a: number | null, b: number | null | undefined) => (a !== null && a > 0 ? r4(a) : b ?? null)
  return {
    ...file,
    size: { width: pick(cli.width, file.size.width)!, height: pick(cli.height, file.size.height)! },
    thickness: pick(cli.thickness, file.thickness),
    minTrack: pick(cli.minTrack, file.minTrack),
    minClearance: pick(cli.minClearance, file.minClearance),
    holes: { ...file.holes, minDiameter: pick(cli.minDrill, file.holes.minDiameter) },
    area: cli.area !== null ? Math.round(cli.area * 100) / 100 : file.area ?? null,
    source: 'file+kicad-cli',
  }
}
